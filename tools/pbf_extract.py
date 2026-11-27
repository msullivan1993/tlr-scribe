"""Read road data for counties from downloaded OpenStreetMap files instead of the Overpass API.

Used by fetch_roads.py when you pass --pbf <file> (once per state file). Download the state files from
Geofabrik, e.g. https://download.geofabrik.de/north-america/us/kentucky-latest.osm.pbf, then:

  py tools\\fetch_roads.py --pbf C:\\osm\\kentucky-latest.osm.pbf --pbf C:\\osm\\ohio-latest.osm.pbf

One pass over each file builds every county in local/counties.txt that lies in it: minutes instead of
hours, and no rate limits. It produces the same data the Overpass queries return, so the road files are
built by exactly the same code either way.

Needs:  pip install osmium shapely   (both ship ready-made wheels for Windows, macOS and Linux)
"""
import sys
from collections import defaultdict

try:
    import osmium
    from shapely.geometry import Point, Polygon, MultiPolygon
    from shapely.prepared import prep
except ImportError:  # pragma: no cover
    sys.exit("The --pbf option needs two Python packages:  py -m pip install osmium shapely")

PLACE_TYPES = {"city", "town", "village", "hamlet", "locality", "neighbourhood", "suburb", "isolated_dwelling"}


def _county_shapes(path, fips_wanted):
    """{fips: prepared (multi)polygon} for the wanted counties found in this file."""
    shapes = {}
    fp = osmium.FileProcessor(path).with_areas(osmium.filter.TagFilter(("boundary", "administrative"))) \
        .with_filter(osmium.filter.EntityFilter(osmium.osm.AREA))
    for a in fp:
        t = a.tags
        if t.get("admin_level") != "6":
            continue
        f = t.get("nist:fips_code") or ""
        if f not in fips_wanted:
            continue
        polys = []
        for outer in a.outer_rings():
            shell = [(n.lon, n.lat) for n in outer]
            holes = [[(n.lon, n.lat) for n in inner] for inner in a.inner_rings(outer)]
            if len(shell) >= 4:
                polys.append(Polygon(shell, holes))
        if polys:
            g = polys[0] if len(polys) == 1 else MultiPolygon(polys)
            if not g.is_valid:
                g = g.buffer(0)
            shapes[f] = (prep(g), g.bounds)
    return shapes


def _counties_for(points, shapes):
    """fips codes whose polygon contains any of the (lon, lat) points (bounding box first)."""
    out = []
    for f, (pg, (x0, y0, x1, y1)) in shapes.items():
        for lon, lat in points:
            if x0 <= lon <= x1 and y0 <= lat <= y1 and pg.contains(Point(lon, lat)):
                out.append(f)
                break
    return out


def _sample(coords):
    """A few points along a way: enough to tell which county it is in without testing every node."""
    if len(coords) <= 3:
        return coords
    step = max(1, len(coords) // 4)
    return coords[::step] + [coords[-1]]


def _seg_dist_m(p, a, b):
    """Metres from point p to the segment a-b (all (lat, lon)), on a local flat projection."""
    import math
    k = math.cos(math.radians(p[0]))
    px, py = p[1] * k * 111320, p[0] * 111320
    ax, ay = a[1] * k * 111320, a[0] * 111320
    bx, by = b[1] * k * 111320, b[0] * 111320
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _near_way(p, coords, metres):
    """True when p is within `metres` of the way's line (like Overpass around.w)."""
    if len(coords) == 1:
        return _seg_dist_m(p, coords[0], coords[0]) <= metres
    return any(_seg_dist_m(p, coords[i], coords[i + 1]) <= metres for i in range(len(coords) - 1))


def _overpass_boundary(fips):
    """Fallback when a county's boundary isn't complete in the downloaded files (border counties sometimes
    aren't): fetch just the boundary from Overpass (one small query) and build the polygon."""
    import json, urllib.parse, urllib.request
    from shapely.geometry import LineString
    from shapely.ops import polygonize, unary_union
    q = f'[out:json][timeout:120];relation["boundary"="administrative"]["admin_level"="6"]["nist:fips_code"="{fips}"];out geom;'
    for url in ("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"):
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(), headers={"User-Agent": "tlr-scribe road builder"})
            with urllib.request.urlopen(req, timeout=150) as r:
                js = json.load(r)
            break
        except Exception as e:  # try the next server
            js, err = None, e
    if not js or not js.get("elements"):
        return None
    outer, inner = [], []
    for m in js["elements"][0].get("members", []):
        g = m.get("geometry") or []
        if m.get("type") == "way" and len(g) >= 2:
            (inner if m.get("role") == "inner" else outer).append(LineString([(p["lon"], p["lat"]) for p in g]))
    polys = list(polygonize(unary_union(outer)))
    if not polys:
        return None
    geom = unary_union(polys)
    if inner:
        holes = list(polygonize(unary_union(inner)))
        if holes:
            geom = geom.difference(unary_union(holes))
    return (prep(geom), geom.bounds)


def _file_box(path):
    """(min lon, min lat, max lon, max lat) from the file header, or None when the file has none."""
    try:
        b = osmium.FileProcessor(path).header.box()
        if b.valid():
            return (b.bottom_left.lon, b.bottom_left.lat, b.top_right.lon, b.top_right.lat)
    except Exception:
        pass
    return None


def extract(paths, counties, skip_highway=None):
    """Returns {fips: {"main": js, "exits": js, "geo": js}} in Overpass JSON shape, for the
    (name, st, fips) counties in the given .osm.pbf (or .osm) files. Each file is read twice: once for
    county boundaries, once for roads. A county's roads are collected from every file that covers it, so
    roads in a neighbouring state's download near the state line are included too."""
    wanted = {f for _, _, f in counties}
    names = {f: f"{n} County, {st}" for n, st, f in counties}
    shapes = {}
    for path in paths:
        todo = wanted - set(shapes)
        if not todo:
            break
        print(f"Reading county boundaries from {path} ...", flush=True)
        found = _county_shapes(path, todo)
        print(f"  {len(found)} of your counties found", flush=True)
        shapes.update(found)
    for f in sorted(wanted - set(shapes)):
        print(f"  {names[f]}: boundary not complete in the downloaded files; fetching just the boundary from Overpass ...", flush=True)
        g = _overpass_boundary(f)
        if g:
            shapes[f] = g
        else:
            print(f"  {names[f]}: no boundary found (check its FIPS code in local/counties.txt)")
    acc = {f: {"main": {}, "geo": {}, "mw": {}} for f in shapes}  # deduplicated by way/node id across files
    special = {}
    milestones = {}
    for path in paths:
        box = _file_box(path)
        mine = {f: v for f, v in shapes.items()
                if box is None or not (v[1][2] < box[0] or v[1][0] > box[2] or v[1][3] < box[1] or v[1][1] > box[3])}
        if not mine:
            continue
        print(f"Reading roads from {path} for {len(mine)} counties (a few minutes for a whole state) ...", flush=True)
        n_ways = 0
        for o in osmium.FileProcessor(path).with_locations():
            if o.is_node():
                t = o.tags
                if not t or not o.location.valid():
                    continue
                ll = (o.location.lat, o.location.lon)
                hw = t.get("highway")
                if hw == "motorway_junction":
                    special[o.id] = (dict(t), ll)
                elif hw == "milestone":
                    milestones[o.id] = (dict(t), ll)
                is_place = t.get("place") in PLACE_TYPES and t.get("name")
                is_poi = t.get("name") and t.get("addr:housenumber") and t.get("addr:street")
                if is_place or is_poi:
                    for f in _counties_for([(ll[1], ll[0])], mine):
                        acc[f]["main"][("node", o.id)] = {"type": "node", "id": o.id, "tags": dict(t)}
            elif o.is_way():
                t = o.tags
                hw = t.get("highway")
                road = hw and (t.get("name") or t.get("ref"))
                poi = t.get("name") and t.get("addr:housenumber") and t.get("addr:street")
                if not (road or poi):
                    continue
                try:
                    coords = [(n.lat, n.lon) for n in o.nodes]
                    ids = [n.ref for n in o.nodes]
                except osmium.InvalidLocationError:
                    continue
                if not coords:
                    continue
                fs = _counties_for([(lon, lat) for lat, lon in _sample(coords)], mine)
                if not fs:
                    continue
                tags = dict(t)
                for f in fs:
                    acc[f]["main"][("way", o.id)] = {"type": "way", "id": o.id, "tags": tags}
                    if road:
                        acc[f]["geo"][o.id] = {"type": "way", "id": o.id, "tags": tags, "nodes": ids,
                                               "geometry": [{"lat": a, "lon": b} for a, b in coords]}
                        if hw == "motorway" and str(t.get("ref", "")).startswith("I"):
                            acc[f]["mw"][o.id] = (tags, ids, coords)
                n_ways += 1
            # Relations (multipolygon buildings with an address) are skipped: nodes and ways cover nearly
            # all addressed places.
        print(f"  {n_ways} roads and addressed places matched", flush=True)
    result = {}
    for f, a in acc.items():
        pg = shapes[f][0]
        els = []
        # Interstate exits and mile posts, in the order parse_exits expects: way tags, then its points.
        for tags, ids, coords in a["mw"].values():
            els.append({"type": "way", "tags": tags})
            for nid in ids:
                if nid in special:
                    st, ll = special[nid]
                    if pg.contains(Point(ll[1], ll[0])):
                        els.append({"type": "node", "id": nid, "lat": ll[0], "lon": ll[1], "tags": st})
            lats = [c[0] for c in coords]; lons = [c[1] for c in coords]
            bx = (min(lats) - 0.001, max(lats) + 0.001, min(lons) - 0.001, max(lons) + 0.001)
            for mt, ll in milestones.values():
                if bx[0] <= ll[0] <= bx[1] and bx[2] <= ll[1] <= bx[3] and pg.contains(Point(ll[1], ll[0])) \
                        and _near_way(ll, coords, 40):
                    els.append({"type": "node", "lat": ll[0], "lon": ll[1], "tags": mt})
        result[f] = {"main": {"elements": list(a["main"].values())}, "exits": {"elements": els},
                     "geo": {"elements": list(a["geo"].values())}}
    return result
