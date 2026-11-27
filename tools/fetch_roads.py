"""
Build per-county road and place lists from OpenStreetMap for TLR Scribe.

Writes roads/<county>-<st>.txt (e.g. roads/cabell-wv.txt) with these sections:
  ## ROADS          every named road (name, plus alt_name / old_name), junk filtered out
  ## ROUTE NUMBERS  route numbers (US 23, KY 3, WV 152, SR 7, I 64, County Road 31, Township Road 1107)
  ## ROUTE NAMES    which local names carry which route: "US 23 = Greenup Avenue; Winchester Avenue"
  ## PLACES         cities, towns, villages, hamlets and named localities
  ## ADDRESSED PLACES  named businesses, apartments, schools, churches by house number and street
  ## INTERSTATE EXITS  interstate exit numbers (= mile markers) in the county, with what they serve
  ## INTERSTATE POINTS  lat,lon of each exit and each whole mile marker, for map images
  ## ROAD POINTS    lat,lon of the middle of each named road, for map images ("Okera Road = 38.3,-83.0")
  ## INTERSECTIONS  every place two named roads or routes meet, with lat,lon
                    ("KY 2 & Okera Road = 38.31,-83.05"); used for map pins and by tools/roadmatch.py

Your own additions live in local/roads/manual/<county>-<st>.txt and are merged in on every rebuild,
so they are never lost. One per line:
  Russell Road = US 23        (a local name for a route)
  Big Bend Road               (a real road the map is missing)
  place: Hurricane Branch     (a community the map is missing)
  addr: 1301 Madison Avenue = Madison Manor Apartments (apartments)   (a named business or complex)
  exit: I 64 191 = US 23; Catlettsburg                                 (an interstate exit the map is missing)
  # comments are ignored

Uses only the Python standard library (the faster --pbf mode needs: py -m pip install osmium shapely).
Run from the repository root:
  py tools\\fetch_roads.py               (all counties in local/counties.txt, from the Overpass API: slow)
  py tools\\fetch_roads.py --pbf C:\\osm\\kentucky-latest.osm.pbf --pbf C:\\osm\\ohio-latest.osm.pbf
                                       (FAST: from downloaded Geofabrik state files, one --pbf per state;
                                        https://download.geofabrik.de/north-america/us.html)
  py tools\\fetch_roads.py --pbf ... --out C:\\temp\\roads-test   (write somewhere else, to compare first)
  py tools\\fetch_roads.py Cabell:WV     (just one)
  py tools\\fetch_roads.py --manual-only (re-merge manual files without downloading again)
  py tools\\fetch_roads.py --geo-only    (keep the lists, add/refresh ROAD POINTS and INTERSECTIONS only)

Data (c) OpenStreetMap contributors, ODbL.
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date
from pathlib import Path

# Counties to build come from local/counties.txt, one per line: Name:ST:FIPS (e.g. Boyd:KY:21019).
# The FIPS code is the 5-digit county code (state + county), unrelated to your TLR system IDs. Names repeat
# across states, so FIPS is what selects the county.
def load_counties():
    for p in (Path("local/counties.txt"), Path("counties.txt")):
        if p.exists():
            out = []
            for line in p.read_text(encoding="utf-8").splitlines():
                line = line.split("#", 1)[0].strip()
                if not line:
                    continue
                parts = [x.strip() for x in line.split(":")]
                if len(parts) != 3:
                    sys.exit(f"{p}: bad line {line!r} (want Name:ST:FIPS)")
                out.append((parts[0], parts[1].upper(), parts[2]))
            return out
    return []

COUNTIES = load_counties()

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# Not roads a dispatcher would send anyone to.
SKIP_HIGHWAY = {"footway", "path", "cycleway", "steps", "bridleway", "corridor", "platform",
                "proposed", "construction", "abandoned", "razed", "elevator", "via_ferrata"}

QUERY = """
[out:json][timeout:600];
area["boundary"="administrative"]["admin_level"="6"]["nist:fips_code"="{fips}"]->.c;
(
  way["highway"]["name"](area.c);
  way["highway"]["ref"](area.c);
  node["place"~"^(city|town|village|hamlet|locality|neighbourhood|suburb|isolated_dwelling)$"]["name"](area.c);
  nwr["name"]["addr:housenumber"]["addr:street"](area.c);
);
out tags;
"""

# Interstate exits: each motorway way's tags, then its exit nodes and the mile-marker posts beside it
# inside the county (with coordinates, for map images), in that order.
EXIT_QUERY = """
[out:json][timeout:300];
area["boundary"="administrative"]["admin_level"="6"]["nist:fips_code"="{fips}"]->.c;
way["highway"="motorway"]["ref"~"^I"](area.c)->.m;
foreach.m->.w(
  .w out tags;
  node(w.w)["highway"="motorway_junction"](area.c);
  out;
  node(around.w:40)["highway"="milestone"](area.c);
  out;
);
"""

# Road geometry: every named or numbered road with its node ids and coordinates, for road midpoints and
# intersections (two differently named roads sharing a node).
GEO_QUERY = """
[out:json][timeout:600];
area["boundary"="administrative"]["admin_level"="6"]["nist:fips_code"="{fips}"]->.c;
(
  way["highway"]["name"](area.c);
  way["highway"]["ref"](area.c);
);
out body geom;
"""

STATE_ROUTE = {"KY": "KY", "OH": "SR", "WV": "WV"}

# --- junk filters -------------------------------------------------------------
JUNK_NAME = [
    re.compile(r"^(cs|ic|cr|tr)-\d+[a-z]?$", re.I),                    # internal codes: Cs-1025, Ic-8203
    re.compile(r"^(\d{3,})(st|nd|rd|th)?\s+(avenue|road|street)$", re.I),  # fake grid: 463rd Avenue, 909th Road
    re.compile(r"(travel center|cemetery$|trailer p(ar)?k$|vocational|entrance$|\bsch(oo)?$|^private \d+ road$)", re.I),
]
JUNK_REF = [
    re.compile(r"^(CS|IC)\s"),          # county/city street inventory codes
    re.compile(r"^[NSEW]\s\d"),          # N 11, S 8A
]


def is_junk_name(name):
    m = JUNK_NAME[1].match(name)
    if m and int(m.group(1)) < 300:      # real numbered streets (1st..299th) are kept
        return False
    return any(p.search(name) for p in JUNK_NAME)


def norm_ref(ref, st):
    """Normalize OSM refs. Ohio county/township roads become 'County Road 31' / 'Township Road 1107'."""
    out = set()
    for part in re.split(r"[;,]", ref):
        p = re.sub(r"\s+", " ", part.strip().upper().replace("-", " "))
        if not p:
            continue
        p = re.sub(r"^(US|I|KY|OH|SR|WV|CR|TR|C|T|CO RD|TWP RD|TWP|CO)\s*(\d)", r"\1 \2", p)
        m = re.match(r"^(CR|C|CO RD|CO|COUNTY ROAD)\s(\d+(?:\s?[A-Z])?)$", p)
        if m:
            out.add(f"County Road {m.group(2)}")
            continue
        m = re.match(r"^(TR|T|TWP RD|TWP|TOWNSHIP ROAD)\s(\d+(?:\s?[A-Z])?)$", p)
        if m:
            out.add(f"Township Road {m.group(2)}")
            continue
        if re.fullmatch(r"\d+[A-Z]?", p):  # bare number: assume a state route
            p = f"{STATE_ROUTE.get(st, st)} {p}"
        if st == "OH":
            p = re.sub(r"^OH\s", "SR ", p)
        if any(j.search(p) for j in JUNK_REF):
            continue
        out.add(p)
    return out


PBF = None  # {fips: {"main", "exits", "geo"}} when --pbf files are given (tools/pbf_extract.py)


def fetch(county, st, fips, query=None):
    if PBF is not None:
        kind = "exits" if query is EXIT_QUERY else "geo" if query is GEO_QUERY else "main"
        if fips not in PBF:
            raise RuntimeError(f"{county} County, {st} (FIPS {fips}) is not in the --pbf file(s)")
        return PBF[fips][kind]
    q = (query or QUERY).format(fips=fips)
    data = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for url in ENDPOINTS:
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, data=data, headers={"User-Agent": "tssn-autoposting road list builder"})
                with urllib.request.urlopen(req, timeout=700) as r:
                    return json.load(r)
            except Exception as e:  # rate limits and timeouts: wait and retry, then try the next server
                last = e
                time.sleep(20 * (attempt + 1))
    raise RuntimeError(f"Overpass failed for {county} {st}: {last}")


# Named, addressed places that are NOT private homes: businesses, apartment complexes, schools,
# churches, public buildings. Single-family houses are never listed.
POI_KEYS = ("amenity", "shop", "office", "tourism", "leisure", "healthcare", "craft", "industrial", "man_made", "aeroway", "public_transport")
POI_BUILDINGS = {"apartments", "commercial", "retail", "industrial", "office", "school", "church", "hospital",
                 "hotel", "warehouse", "public", "civic", "government", "university", "college", "dormitory", "supermarket", "fire_station"}


def poi_kind(t):
    if t.get("building") in {"house", "detached", "residential", "semidetached_house", "terrace", "bungalow", "farm", "cabin"} and not any(k in t for k in POI_KEYS):
        return None
    for k in POI_KEYS:
        if k in t:
            return f"{k}={t[k]}"
    if t.get("building") in POI_BUILDINGS:
        return f"building={t['building']}"
    if t.get("landuse") == "residential" and t.get("residential") == "apartments":
        return "apartments"
    return None


def parse_osm(js, st):
    roads, refs, places = set(), set(), set()
    pairs = defaultdict(set)  # route -> names
    pois = set()
    for el in js.get("elements", []):
        t = el.get("tags", {})
        if t.get("addr:housenumber") and t.get("addr:street") and t.get("name") and "highway" not in t:
            kind = poi_kind(t)
            if kind:
                pois.add(f"{t['addr:housenumber'].strip()} {t['addr:street'].strip()} = {t['name'].strip()} ({kind})")
            continue
        if "place" in t and el.get("type") == "node":
            places.add(t["name"].strip())
            continue
        if t.get("highway") in SKIP_HIGHWAY:
            continue
        names = set()
        for key in ("name", "alt_name", "old_name", "official_name", "loc_name"):
            for v in str(t.get(key, "")).split(";"):
                v = v.strip()
                if v and not is_junk_name(v):
                    names.add(v)
        road_refs = norm_ref(t["ref"], st) if t.get("ref") else set()
        roads |= names
        refs |= road_refs
        for r in road_refs:
            for n in names:
                if n.upper().replace(" ", "") != r.upper().replace(" ", ""):  # skip "County Road 31" = County Road 31
                    pairs[r].add(n)
    return roads, refs, places, pairs, pois


def parse_exits(js, points=None):
    """{route: {exit number: description}} from EXIT_QUERY output (way tags followed by its exit nodes).
    If points is a dict, also fills points[route]["exit"][num] and points[route]["mm"][mile] with lists of (lat, lon)."""
    exits = defaultdict(dict)
    current = []
    for el in js.get("elements", []):
        t = el.get("tags", {})
        if el.get("type") == "way":
            current = [r for r in norm_ref(t.get("ref", ""), "") if r.startswith("I ")]
            continue
        if points is not None and current and "lat" in el and "lon" in el:
            ll = (el["lat"], el["lon"])
            if t.get("highway") == "milestone":
                m = re.match(r"\s*(\d+(?:\.\d+)?)", str(t.get("distance") or t.get("pk") or t.get("ref") or ""))
                if m:
                    for r in current:
                        points[r]["mm"][float(m.group(1))].append(ll)
                continue
            for r in current:
                for n in re.split(r"[;,]", str(t.get("ref", ""))):
                    if n.strip():
                        points[r]["exit"][n.strip().upper()].append(ll)
        if t.get("highway") == "milestone":
            continue
        num = str(t.get("ref", "")).strip()
        if not num or not current:
            continue
        desc = "; ".join(x for x in (t.get("exit_to") or t.get("destination:ref") or "", t.get("destination") or t.get("name") or "") if x)
        desc = re.sub(r"\s*;\s*", "; ", desc).strip("; ")
        for r in current:
            for n in re.split(r"[;,]", num):
                n = n.strip().upper()
                if n and (n not in exits[r] or len(desc) > len(exits[r][n])):
                    exits[r][n] = desc
    return exits


def new_points():
    return defaultdict(lambda: {"exit": defaultdict(list), "mm": defaultdict(list)})


def avg(lls):
    return (sum(a for a, _ in lls) / len(lls), sum(b for _, b in lls) / len(lls))


def point_lines(points):
    """Lines for the INTERSTATE POINTS section: one point per exit (the middle of its ramps) and one per
    whole mile marker (an OSM mile post where mapped; otherwise placed between the nearest known posts or
    exits up to 6 miles apart, along a straight line, so it is approximate)."""
    out = []
    for r in sorted(points, key=route_sort):
        ex = {n: avg(v) for n, v in points[r]["exit"].items() if v}
        posts = {m: avg(v) for m, v in points[r]["mm"].items() if v}
        known = dict(posts)
        for n, ll in ex.items():
            k = exit_num(n)
            if k >= 0 and float(k) not in known:
                known[float(k)] = ll
        for n in sorted(ex, key=lambda n: (exit_num(n), n)):
            out.append(f"{r} Exit {n} = {ex[n][0]:.5f},{ex[n][1]:.5f}")
        if not known:
            continue
        ks = sorted(known)
        for mile in range(int(ks[0]), int(ks[-1]) + 1):
            if float(mile) in known:
                ll, how = known[float(mile)], ""
            else:
                lo = max((k for k in ks if k < mile), default=None)
                hi = min((k for k in ks if k > mile), default=None)
                if lo is None or hi is None or hi - lo > 6:
                    continue
                f = (mile - lo) / (hi - lo)
                ll = (known[lo][0] + f * (known[hi][0] - known[lo][0]), known[lo][1] + f * (known[hi][1] - known[lo][1]))
                how = " ~"
            out.append(f"{r} MM {mile} = {ll[0]:.5f},{ll[1]:.5f}{how}")
    return out


def dist_m(a, b):
    import math
    dy = (a[0] - b[0]) * 111320
    dx = (a[1] - b[1]) * 111320 * math.cos(math.radians((a[0] + b[0]) / 2))
    return (dx * dx + dy * dy) ** 0.5


def parse_geo(js, st):
    """ROAD POINTS and INTERSECTIONS lines from GEO_QUERY output.
    Labels: each way's names (name, alt_name, old_name, loc_name) and route numbers (US 23, KY 2).
    A road's point is the node nearest the middle of all its nodes (so it lies on the road).
    An intersection is a node shared by ways with different labels; one pair may meet several
    times, kept when the points are over 400 m apart (at most 4)."""
    node_ways = defaultdict(list)  # node -> label sets of the ways through it
    node_ll = {}
    label_pts = defaultdict(list)
    for el in js.get("elements", []):
        if el.get("type") != "way":
            continue
        t = el.get("tags", {})
        if t.get("highway") in SKIP_HIGHWAY:
            continue
        labels = set()
        for key in ("name", "alt_name", "old_name", "loc_name"):
            for v in str(t.get(key, "")).split(";"):
                v = v.strip()
                if v and not is_junk_name(v):
                    labels.add(v)
        if t.get("ref"):
            labels |= norm_ref(t["ref"], st)
        if not labels:
            continue
        geom = el.get("geometry") or []
        for nid, g in zip(el.get("nodes", []), geom):
            if not g:
                continue
            ll = (g["lat"], g["lon"])
            node_ll[nid] = ll
            node_ways[nid].append(frozenset(labels))
            for lb in labels:
                label_pts[lb].append(ll)
    road_lines = []
    for lb in sorted(label_pts, key=str.lower):
        if re.match(r"^(I|US|SR|[A-Z]{2}) \d", lb):
            continue  # long numbered routes: a midpoint is meaningless; use INTERSECTIONS / mile points
        pts = label_pts[lb]
        mid = avg(pts)
        best = min(pts, key=lambda p: dist_m(p, mid))
        road_lines.append(f"{lb} = {best[0]:.5f},{best[1]:.5f}")
    pairs = defaultdict(list)
    for nid, ways in node_ways.items():
        if len(ways) < 2:
            continue
        found = set()
        for i in range(len(ways)):
            for j in range(i + 1, len(ways)):
                # labels of one way never "intersect" each other (KY 2 and its local name Lawton Road)
                for a in ways[i] - ways[j]:
                    for b in ways[j] - ways[i]:
                        if a.upper().replace(" ", "") != b.upper().replace(" ", ""):
                            found.add(tuple(sorted((a, b), key=str.lower)))
        for k in found:
            pairs[k].append(node_ll[nid])
    inter_lines = []
    for (a, b) in sorted(pairs, key=lambda k: (k[0].lower(), k[1].lower())):
        kept = []
        for ll in pairs[(a, b)]:
            if all(dist_m(ll, k) > 400 for k in kept):
                kept.append(ll)
            if len(kept) >= 4:
                break
        for ll in kept:
            inter_lines.append(f"{a} & {b} = {ll[0]:.5f},{ll[1]:.5f}")
    return road_lines, inter_lines


def exit_num(n):
    m = re.match(r"(\d+)", n)
    return int(m.group(1)) if m else -1


def merge_manual(path, st, roads, refs, places, pairs, pois, exits=None):
    if not path.exists():
        return 0
    n = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        n += 1
        if line.lower().startswith("place:"):
            places.add(line.split(":", 1)[1].strip())
        elif line.lower().startswith("addr:"):
            pois.add(line.split(":", 1)[1].strip())
        elif line.lower().startswith("exit:") and exits is not None:
            m = re.match(r"(I\s*\d+)\s+(\w+)\s*(?:=\s*(.*))?$", line.split(":", 1)[1].strip(), re.I)
            if m:
                exits[re.sub(r"\s+", " ", m.group(1).upper().replace("I", "I ", 1)).strip()][m.group(2).upper()] = (m.group(3) or "").strip()
        elif "=" in line:
            name, route = (x.strip() for x in line.split("=", 1))
            for r in norm_ref(route, st) or {route.upper()}:
                refs.add(r)
                pairs[r].add(name)
            roads.add(name)
        else:
            roads.add(line)
    return n


def read_existing(path):
    """For --manual-only: read an existing output file back into sets."""
    roads, refs, places, pairs, pois = set(), set(), set(), defaultdict(set), set()
    exits = defaultdict(dict)
    point_text = []
    geo = ([], [])
    section = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            section = line[3:].split(" (")[0].strip()
            continue
        if not line.strip() or line.startswith("#"):
            continue
        if section == "ROADS":
            roads.add(line.strip())
        elif section == "ROUTE NUMBERS":
            refs.add(line.strip())
        elif section == "PLACES":
            places.add(line.strip())
        elif section == "ADDRESSED PLACES":
            pois.add(line.strip())
        elif section == "ROUTE NAMES" and " = " in line:
            r, names = line.split(" = ", 1)
            pairs[r.strip()] |= {x.strip() for x in names.split(";") if x.strip()}
        elif section == "INTERSTATE EXITS":
            m = re.match(r"(I \d+) Exit (\S+)(?: = (.*))?$", line.strip())
            if m:
                exits[m.group(1)][m.group(2)] = (m.group(3) or "").strip()
        elif section == "INTERSTATE POINTS":
            point_text.append(line.strip())
        elif section == "ROAD POINTS":
            geo[0].append(line.strip())
        elif section == "INTERSECTIONS":
            geo[1].append(line.strip())
    read_existing.geo = geo
    return roads, refs, places, pairs, pois, exits, point_text


def route_sort(r):
    m = re.search(r"(\d+)", r)
    return (r.split(" ")[0], int(m.group(1)) if m else 0, r)


def write(path, county, st, roads, refs, places, pairs, pois, exits=None, point_text=None, geo=None):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(f"# {county} County, {st}. Source: OpenStreetMap contributors (ODbL) plus local/roads/manual, built {date.today()}.\n")
        f.write("## ROADS\n" + "\n".join(sorted(roads, key=str.lower)) + "\n")
        f.write("## ROUTE NUMBERS\n" + "\n".join(sorted(refs, key=route_sort)) + "\n")
        f.write("## ROUTE NAMES\n")
        for r in sorted(pairs, key=route_sort):
            if pairs[r]:
                f.write(f"{r} = {'; '.join(sorted(pairs[r], key=str.lower))}\n")
        f.write("## PLACES\n" + "\n".join(sorted(places, key=str.lower)) + "\n")
        f.write("## ADDRESSED PLACES (house number + street = name (type); businesses, apartments, schools, churches; never private homes)\n")
        f.write("\n".join(sorted(pois, key=lambda x: (x.split(" ", 1)[1].lower() if " " in x else x, x))) + "\n")
        f.write(f"## INTERSTATE EXITS (exit number = mile marker; numbers restart at each state line, {st} numbering)\n")
        for r in sorted(exits or {}, key=route_sort):
            nums = sorted(exits[r], key=lambda n: (exit_num(n), n))
            if not nums:
                continue
            f.write(f"{r}: exits {exit_num(nums[0])}-{exit_num(nums[-1])}\n")
            for n in nums:
                f.write(f"{r} Exit {n}" + (f" = {exits[r][n]}" if exits[r][n] else "") + "\n")
        if point_text:
            f.write("## INTERSTATE POINTS (lat,lon for map images: each exit, and each mile marker; ~ = estimated between known points)\n")
            f.write("\n".join(point_text) + "\n")
        if geo and (geo[0] or geo[1]):
            f.write("## ROAD POINTS (lat,lon of the middle of each named road, for map images; long numbered routes are not listed)\n")
            f.write("\n".join(geo[0]) + "\n")
            f.write("## INTERSECTIONS (where two named roads or routes meet: \"A & B = lat,lon\", names in alphabetical order; a pair can meet more than once)\n")
            f.write("\n".join(geo[1]) + "\n")


def main():
    global PBF
    argv = sys.argv[1:]
    pbf_files = []
    while "--pbf" in argv:
        i = argv.index("--pbf")
        if i + 1 >= len(argv):
            sys.exit("--pbf needs a file, e.g. --pbf C:\\osm\\kentucky-latest.osm.pbf")
        pbf_files.append(argv[i + 1])
        del argv[i:i + 2]
    out_override = None
    if "--out" in argv:
        i = argv.index("--out")
        if i + 1 >= len(argv):
            sys.exit("--out needs a folder")
        out_override = argv[i + 1]
        del argv[i:i + 2]
    args = [a for a in argv if not a.startswith("--")]
    manual_only = "--manual-only" in sys.argv
    exits_only = "--exits-only" in sys.argv  # keep the road lists, refetch only interstate exits and points (fast)
    geo_only = "--geo-only" in sys.argv  # keep the road lists, fetch only ROAD POINTS and INTERSECTIONS
    if args:
        want = {tuple(x.lower() for x in a.split(":", 1)) for a in args}
        picks = [c for c in COUNTIES if (c[0].lower(), c[1].lower()) in want]
        missing = want - {(c[0].lower(), c[1].lower()) for c in picks}
        if missing:
            print("Not in COUNTIES (add it with its FIPS code):", ", ".join(":".join(m) for m in missing))
    else:
        picks = COUNTIES
    failed = []
    if not picks:
        sys.exit("No counties. Add lines like Boyd:KY:21019 to local/counties.txt")
    # local/roads is the instance layout; plain roads/ is kept for older checkouts
    outdir = Path("local/roads") if Path("local").is_dir() or not Path("roads").is_dir() else Path("roads")
    manual_dir = outdir / "manual"
    if out_override:  # e.g. --out C:\temp\roads-test, to compare a new build with the current files
        outdir = Path(out_override)
        outdir.mkdir(parents=True, exist_ok=True)
    manual_dir.mkdir(parents=True, exist_ok=True)
    if pbf_files:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import pbf_extract
        t0 = time.time()
        PBF = pbf_extract.extract(pbf_files, picks, SKIP_HIGHWAY)
        print(f"Read the file(s) in {int(time.time() - t0)} s.\n")
    for county, st, fips in picks:
        slug = f"{county.lower().replace(' ', '-')}-{st.lower()}"
        path = outdir / f"{slug}.txt"
        print(f"{county} County, {st} ...", flush=True)
        geo = None
        if manual_only or exits_only or geo_only:
            if not path.exists():
                print("  no existing file, skipped (run a full build first)")
                continue
            roads, refs, places, pairs, pois, exits, point_text = read_existing(path)
            geo = read_existing.geo
            if geo_only:
                try:
                    geo = parse_geo(fetch(county, st, fips, GEO_QUERY), st)
                except Exception as e:
                    print(f"  FAILED: {e}")
                    failed.append(f"{county}:{st}")
                    continue
            if exits_only:
                if not any(r.startswith("I ") for r in refs):
                    print("  no interstate in this county, skipped")
                    continue
                try:
                    points = new_points()
                    exits = parse_exits(fetch(county, st, fips, EXIT_QUERY), points)
                    point_text = point_lines(points)
                except Exception as e:
                    print(f"  FAILED: {e}")
                    failed.append(f"{county}:{st}")
                    continue
        else:
            try:
                roads, refs, places, pairs, pois = parse_osm(fetch(county, st, fips), st)
                exits = defaultdict(dict)
                point_text = []
                if any(r.startswith("I ") for r in refs):
                    time.sleep(0 if PBF is not None else 5)
                    try:
                        points = new_points()
                        exits = parse_exits(fetch(county, st, fips, EXIT_QUERY), points)
                        point_text = point_lines(points)
                    except Exception as e:
                        print(f"  exits not fetched ({e}); the road list is still written")
                time.sleep(0 if PBF is not None else 5)
                try:
                    geo = parse_geo(fetch(county, st, fips, GEO_QUERY), st)
                except Exception as e:
                    print(f"  road points not fetched ({e}); the road list is still written")
            except Exception as e:
                print(f"  FAILED: {e}")
                failed.append(f"{county}:{st}")
                continue
            if not roads:
                print(f"  FAILED: no roads returned for FIPS {fips}")
                failed.append(f"{county}:{st}")
                continue
        m = merge_manual(manual_dir / f"{slug}.txt", st, roads, refs, places, pairs, pois, exits)
        write(path, county, st, roads, refs, places, pairs, pois, exits, point_text, geo)
        print(f"  {len(roads)} roads, {len(refs)} routes, {sum(1 for r in pairs if pairs[r])} named routes, "
              f"{len(places)} places, {len(pois)} addressed places, {sum(len(v) for v in exits.values())} interstate exits, "
              f"{len(point_text)} interstate points, "
              f"{len(geo[0]) if geo else 0} road points, {len(geo[1]) if geo else 0} intersections, "
              f"{m} manual lines -> {path}")
        if PBF is not None:
            pass
        elif exits_only or geo_only:
            time.sleep(3)
        elif not manual_only:
            time.sleep(10)  # be polite to the public Overpass servers
    if failed:
        print("\nThese failed (" + ("see the reason above each one" if PBF is not None else "usually a busy server") + "). Rerun just them with:")
        print("  py tools\\fetch_roads.py " + " ".join(failed))


if __name__ == "__main__":
    main()
