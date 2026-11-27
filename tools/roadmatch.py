"""
Sound-alike road matcher for TLR Scribe.

Finds the county road a garbled transcript most likely means ("OPHRAH ROAD" -> Okera Road), tuned for
scanner radio and local accents:
  - vowels count very little (a drawl stretches and swaps them: "Pike" ~ "Pahk", "Okera" ~ "Okra")
  - consonants the radio smears together are near-misses: F/K/P/TH, T/D/K, S/F, M/N, L/R, B/P, G/K, J/K
  - "holler" = hollow, dropped final G ("Fishin" = Fishing), split words ("OAK ERA" = Okera)
  - when the transcript names a cross road ("STATE HIGHWAY 2 AND OPHRAH ROAD"), roads that really meet
    it (INTERSECTIONS section of the road file) are strongly preferred

Usage (from the repository root):
  python3 tools/roadmatch.py carter-ky "RESPOND TO STATE HIGHWAY 2 AND OPHRAH ROAD FOR A ROLLOVER"

Output: one block per road-like phrase not already in the county's road list, best candidates first:
  heard "OPHRAH ROAD" -> Okera Road  score 0.91  STRONG  (meets KY 2)
Verdicts: STRONG = use it; POSSIBLE = use only if the department, area or other traffic agrees;
nothing listed = no good match, treat the road as unknown.
Standard library only.
"""
import re
import sys
from pathlib import Path

SUFFIX = {
    "ROAD": "ROAD", "RD": "ROAD", "LANE": "LANE", "LN": "LANE", "DRIVE": "DRIVE", "DR": "DRIVE",
    "STREET": "STREET", "ST": "STREET", "AVENUE": "AVENUE", "AVE": "AVENUE", "HOLLOW": "HOLLOW",
    "HOLLER": "HOLLOW", "HOLLAR": "HOLLOW", "HOLLA": "HOLLOW", "BRANCH": "BRANCH", "CREEK": "CREEK",
    "CRICK": "CREEK", "FORK": "FORK", "PIKE": "PIKE", "RIDGE": "RIDGE", "HILL": "HILL", "WAY": "WAY",
    "COURT": "COURT", "CT": "COURT", "CIRCLE": "CIRCLE", "LOOP": "LOOP", "TRAIL": "TRAIL",
    "BOTTOM": "BOTTOM", "RUN": "RUN", "HIGHWAY": "HIGHWAY", "BOULEVARD": "BOULEVARD", "PLACE": "PLACE",
    "GAP": "GAP", "MOUNTAIN": "MOUNTAIN", "FLATS": "FLATS", "HEIGHTS": "HEIGHTS", "ESTATES": "ESTATES",
}
STOP = {"THE", "ON", "TO", "OF", "FOR", "AND", "A", "AN", "AT", "IN", "OFF", "NEAR", "BY", "HE", "SHE",
        "IS", "WAS", "UP", "DOWN", "OUT", "RESPOND", "RESPONDING", "UNITS", "UNIT", "AREA", "WITH",
        "FROM", "THAT", "THIS", "THERE", "ITS", "GOING", "BE", "WILL", "REFERENCE", "ADVISED", "CALLER",
        "OLD", "NEW", "NORTH", "SOUTH", "EAST", "WEST", "OR", "BLOCK", "MILE", "PAST", "BEFORE", "AFTER",
        "STATION", "ENGINE", "MEDIC", "RESCUE", "SQUAD", "SIGNAL", "CODE", "COPY", "CLEAR", "ROUTE"}
ROUTE_WORDS = r"(?:STATE HIGHWAY|STATE ROUTE|STATE ROAD|STATE RTE|HIGHWAY|HWY|ROUTE|RT|KY|SR|WV|US HIGHWAY|US ROUTE|US|INTERSTATE|I)"
CROSS_WORDS = {"AND", "AT", "&", "NEAR", "OFF", "BY", "PAST"}


# --- sound key -----------------------------------------------------------------------------------
def skeleton(word):
    """Consonant skeleton for radio + accent matching. 'OKERA' -> 'AKR', 'OPHRAH' -> 'AFR'."""
    s = re.sub(r"[^A-Z]", "", word.upper())
    if not s:
        return ""
    for a, b in (("PH", "F"), ("GH", ""), ("CK", "K"), ("QU", "KW"), ("Q", "K"), ("X", "KS"), ("TH", "F"),
                 ("DG", "J"), ("WR", "R"), ("KN", "N"), ("SCH", "SK"), ("SH", "S"), ("CH", "K")):
        s = s.replace(a, b)
    s = re.sub(r"C(?=[EIY])", "S", s).replace("C", "K")
    s = s.translate(str.maketrans("ZVBGD", "SFPKT"))
    s = re.sub(r"ING$", "IN", s)  # dropped final G
    first = "A" if s[0] in "AEIOU" else s[0]
    rest = re.sub(r"[AEIOUYWH]", "", s[1:])
    out = first
    for ch in rest:
        if ch != out[-1]:
            out += ch
    return out


NEAR = {}
for pair, cost in ((("K", "F"), .5), (("P", "F"), .5), (("K", "P"), .5), (("T", "K"), .6), (("T", "P"), .6),
                   (("M", "N"), .4), (("L", "R"), .6), (("S", "F"), .6), (("J", "K"), .5), (("S", "J"), .6),
                   (("T", "F"), .6), (("N", "L"), .7)):
    NEAR[pair] = NEAR[pair[::-1]] = cost


def wdist(a, b):
    """Weighted edit distance on skeletons: near-sounding swaps cost less; a leading vowel or a
    trailing R/L/N is cheap to add or drop (drawl)."""
    n, m = len(a), len(b)
    d = [[0.0] * (m + 1) for _ in range(n + 1)]

    def indel(ch, pos, length):
        if pos == 0 and ch == "A":
            return .5
        if pos == length - 1 and ch in "RLN":
            return .6
        return 1.0
    for i in range(1, n + 1):
        d[i][0] = d[i - 1][0] + indel(a[i - 1], i - 1, n)
    for j in range(1, m + 1):
        d[0][j] = d[0][j - 1] + indel(b[j - 1], j - 1, m)
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            x, y = a[i - 1], b[j - 1]
            sub = 0.0 if x == y else NEAR.get((x, y), 1.0)
            d[i][j] = min(d[i - 1][j] + indel(x, i - 1, n), d[i][j - 1] + indel(y, j - 1, m), d[i - 1][j - 1] + sub)
    return d[n][m]


def jaro_winkler(s1, s2):
    if s1 == s2:
        return 1.0
    l1, l2 = len(s1), len(s2)
    if not l1 or not l2:
        return 0.0
    rng = max(l1, l2) // 2 - 1
    m1, m2 = [False] * l1, [False] * l2
    matches = 0
    for i in range(l1):
        for j in range(max(0, i - rng), min(i + rng + 1, l2)):
            if not m2[j] and s1[i] == s2[j]:
                m1[i] = m2[j] = True
                matches += 1
                break
    if not matches:
        return 0.0
    t, k = 0, 0
    for i in range(l1):
        if m1[i]:
            while not m2[k]:
                k += 1
            if s1[i] != s2[k]:
                t += 1
            k += 1
    j = (matches / l1 + matches / l2 + (matches - t / 2) / matches) / 3
    p = 0
    for a, b in zip(s1[:4], s2[:4]):
        if a != b:
            break
        p += 1
    return j + p * 0.1 * (1 - j)


def similarity(heard, core):
    """0..1: mostly the sound skeleton, partly the spelling."""
    a, b = skeleton(heard.replace(" ", "")), skeleton(core.replace(" ", ""))
    if not a or not b:
        return 0.0
    sk = max(0.0, 1 - wdist(a, b) / max(len(a), len(b), 2))
    jw = jaro_winkler(heard.replace(" ", ""), core.replace(" ", ""))
    return 0.65 * sk + 0.35 * jw


# --- road file -----------------------------------------------------------------------------------
def split_name(name):
    w = name.upper().replace(".", "").split()
    suf = None
    if len(w) > 1 and w[-1] in SUFFIX:  # only the last road word: "Wicker Hollow Road" -> WICKER HOLLOW
        suf = SUFFIX[w.pop()]
    return " ".join(w), suf


def load(slug):
    path = Path("local/roads") / f"{slug}.txt"
    if not path.exists():
        path = Path("roads") / f"{slug}.txt"
    if not path.exists():
        sys.exit(f"no road file {path}")
    roads, routes, cross = [], set(), {}
    section = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            section = line[3:].split(" (")[0].strip()
            continue
        if not line.strip() or line.startswith("#"):
            continue
        if section == "ROADS":
            core, suf = split_name(line.strip())
            if len(core.replace(" ", "")) >= 3 and not re.match(r"^(KY|US|SR|WV|I|CR|TR) ?\d", core):
                roads.append((line.strip(), core, suf))
        elif section == "ROUTE NUMBERS":
            routes.add(line.strip().upper())
        elif section == "INTERSECTIONS" and " & " in line and " = " in line:
            pair = line.split(" = ")[0]
            a, b = (x.strip().upper() for x in pair.split(" & ", 1))
            cross.setdefault(a, set()).add(b)
            cross.setdefault(b, set()).add(a)
    return roads, routes, cross


# --- transcript ----------------------------------------------------------------------------------
def route_in(text, st_prefix, routes):
    """Route numbers named in the text, as they appear in the road file (KY 2, US 60, SR 7, I 64)."""
    found = set()
    for m in re.finditer(ROUTE_WORDS + r"\s*(\d{1,4}[A-Z]?)\b", text):
        word, num = m.group(0).rsplit(None, 1)[0] if " " in m.group(0) else m.group(0), m.group(1)
        cands = []
        if word.startswith("US"):
            cands = [f"US {num}"]
        elif word in ("I", "INTERSTATE"):
            cands = [f"I {num}"]
        else:
            cands = [f"{st_prefix} {num}", f"US {num}"]
        for c in cands:
            if c in routes:
                found.add(c)
                break
    return found


def phrases(text):
    """(heard words, suffix, word index) for each road-like phrase: 1-3 words before a road word."""
    t = re.sub(r"[^A-Z0-9& ]", " ", text.upper()).split()
    out = []
    for i, w in enumerate(t):
        if w not in SUFFIX:
            continue
        if i + 1 < len(t) and re.match(r"^\d", t[i + 1]):
            continue  # "STATE HIGHWAY 2", "COUNTY ROAD 31": a route number, not a name
        for n in (3, 2, 1):
            if i - n < 0:
                continue
            win = t[i - n:i]
            if any(x.isdigit() or x in STOP or x in SUFFIX for x in win):
                continue
            if " ".join(win) in ("STATE", "US", "COUNTY", "TOWNSHIP", "STATE ROUTE", "STATE HIGHWAY"):
                continue
            out.append((" ".join(win), SUFFIX[w], i - n, t, i))
    return out


def match(slug, text, top=3):
    st_prefix = {"ky": "KY", "oh": "SR", "wv": "WV"}.get(slug.rsplit("-", 1)[-1], "KY")
    roads, routes, cross = load(slug)
    known = {core for _, core, _ in roads}
    text_u = text.upper()
    named_routes = route_in(text_u, st_prefix, routes)
    results = []
    seen = set()
    by_anchor = {}
    for heard, suf, start, toks, anchor in phrases(text_u):
        if heard in known or heard in seen:
            continue
        seen.add(heard)
        # cross roads: routes in the text, plus known road names right around the phrase
        ctx = " ".join(toks[max(0, start - 8):start + 10])
        crossing = set(r for r in named_routes)
        for name, core, _ in roads:
            if core != heard and re.search(r"\b" + re.escape(core) + r"\b", ctx):
                crossing.add(name.upper())
        has_cross_word = bool(set(toks[max(0, start - 8):start + 10]) & CROSS_WORDS)
        scored = []
        for name, core, csuf in roads:
            sc = similarity(heard, core)
            if sc < 0.55:
                continue
            why = []
            if suf and csuf and suf == csuf:
                sc += 0.04
            elif suf and csuf and suf != csuf:
                sc -= 0.03
            meets = sorted(c for c in crossing if c in cross.get(name.upper(), set()))
            if meets and has_cross_word:
                sc += 0.15
                why.append("meets " + ", ".join(m.title() if not re.match(r"^(KY|US|SR|WV|I) ", m) else m for m in meets))
            scored.append((min(sc, 1.0), name, why))
        scored.sort(reverse=True)
        best = scored[:top]
        lines = []
        for k, (sc, name, why) in enumerate(best):
            margin = sc - (best[k + 1][0] if k + 1 < len(best) else 0)
            verdict = "STRONG" if (sc >= 0.86 and (k > 0 or margin >= 0.06)) or (why and sc >= 0.80 and k == 0) else ("POSSIBLE" if sc >= 0.72 else "")
            if not verdict:
                continue
            if k > 0 and verdict == "STRONG":
                verdict = "POSSIBLE"
            lines.append(f'  -> {name}  score {sc:.2f}  {verdict}' + (f"  ({'; '.join(why)})" if why else ""))
        top_score = best[0][0] if best else 0
        prev = by_anchor.get(anchor)
        if prev is None or top_score > prev[0] + 0.02 or (abs(top_score - prev[0]) <= 0.02 and len(heard) > prev[2]):
            by_anchor[anchor] = (top_score, (f'heard "{heard} {suf}"', lines), len(heard))
    return [v[1] for _, v in sorted(by_anchor.items())]


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    slug = sys.argv[1].lower()
    if not re.fullmatch(r"[a-z][a-z-]*-[a-z]{2}", slug):
        sys.exit("county must look like carter-ky")
    # "-" reads the transcript from stdin, so transcript text never has to pass through the shell.
    text = sys.stdin.read() if sys.argv[2:] == ["-"] else " ".join(sys.argv[2:])
    res = match(slug, text)
    if not res:
        print("no unknown road names found")
    for head, lines in res:
        print(head)
        print("\n".join(lines) if lines else "  (no good match: treat as unknown)")


if __name__ == "__main__":
    main()
