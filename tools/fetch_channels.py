"""Collect ThinLine system and talkgroup refs, and fill them into local/channels.csv.

The scribe rules match channels by ref ("[21019/1234]" in alert headers) before names, so you can
rename talkgroups in ThinLine without breaking the key. This script reads recent calls from your
TLR server's public API (/api/public/v1/transcripts), lists every system and talkgroup it saw with
its refs and names, and fills the system_ref / talkgroup_ref columns of local/channels.csv for rows
it can match by name.

Needs TLR_HOST (https://scanner.example.com) and TLR_API_KEY (a tlr_... key with the Transcripts
capability) in the environment or in a git-ignored .env file in the repo root. Read-only.

  py tools\\fetch_channels.py                 list what was seen in the last 24 h -> local/channels-seen.csv
  py tools\\fetch_channels.py --hours 168     look back a week (quiet channels only appear when they had calls)
  py tools\\fetch_channels.py --fill          also fill refs in local/channels.csv (existing refs are kept)
  py tools\\fetch_channels.py --fill --force  overwrite existing refs too
  py tools\\fetch_channels.py --from C:\\temp\\talkgroups.csv --fill
                                             fill from a full list exported from the TLR database
                                             (tools/talkgroups.sql), including channels with no recent calls

Pages are fetched --delay seconds apart (default 1.5) and a 429 rate limit waits and retries.
Only channels that had a call in the window appear. Run it again later (or with more --hours) for the rest.
"""
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def load_env():
    env = dict(os.environ)
    p = Path(".env")
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return env


def arg(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


def norm(x):
    return " ".join(str(x or "").lower().split())


def fetch(host, key, since_ms, max_pages, delay):
    seen = {}
    for page in range(max_pages):
        q = urllib.parse.urlencode({"dateFrom": since_ms, "limit": 200, "offset": page * 200})
        req = urllib.request.Request(f"{host}/api/public/v1/transcripts?{q}",
                                     headers={"Authorization": f"Bearer {key}", "Accept": "application/json",
                                              # Cloudflare blocks Python's default "Python-urllib" agent with a 403
                                              "User-Agent": "tlr-scribe-fetch-channels/1.0 (+https://github.com/msullivan1993/tlr-scribe)"})
        data = None
        for attempt in range(12):
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    data = json.loads(r.read().decode("utf-8"))
                break
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", "replace")[:300]
                if e.code == 429 or e.code >= 500:
                    wait = int(e.headers.get("Retry-After") or 0) or min(15 * (attempt + 1), 90)
                    print(f"  HTTP {e.code} (rate limit or busy server), waiting {wait}s ...", flush=True)
                    time.sleep(wait)
                    continue
                print(f"ThinLine returned HTTP {e.code}: {body}")
                if e.code in (401, 403):
                    print("401/403 from ThinLine: check the key has the Transcripts capability. "
                          "A Cloudflare HTML page instead: a WAF or bot rule is blocking the request.")
                break
            except Exception as e:
                print(f"  request failed ({e}), retrying ...", flush=True)
                time.sleep(5)
        if data is None:
            print("Stopped early; keeping the channels collected so far.")
            break
        batch = data.get("results") or []
        for c in batch:
            sref, tref = c.get("systemRef"), c.get("talkgroupRef")
            if sref in (None, "") or tref in (None, ""):
                continue
            k = (str(sref), str(tref))
            e = seen.setdefault(k, {"system_ref": str(sref), "talkgroup_ref": str(tref),
                                    "system": c.get("systemLabel") or "", "label": c.get("talkgroupLabel") or "",
                                    "name": c.get("talkgroupName") or "", "calls": 0})
            e["calls"] += 1
        print(f"  page {page + 1}: {len(batch)} calls, {len(seen)} channels so far", flush=True)
        if len(batch) < 200:
            break
        time.sleep(delay)
    else:
        print(f"  stopped at --max-pages {max_pages}; older calls in the window were not read")
    return seen


def main():
    env = load_env()
    src = arg("--from")
    hours = float(arg("--hours", "24"))
    max_pages = int(arg("--max-pages", "400"))
    local = Path("local")
    local.mkdir(exist_ok=True)

    if src:
        # A full system/talkgroup list exported from the TLR database (tools/talkgroups.sql)
        with open(src, newline="", encoding="utf-8-sig") as f:
            rows = [{"system": r.get("system", ""), "label": r.get("label", ""), "name": r.get("name", ""),
                     "system_ref": str(r.get("system_ref", "")).strip(), "talkgroup_ref": str(r.get("talkgroup_ref", "")).strip(), "calls": ""}
                    for r in csv.DictReader(f)]
        rows = [r for r in rows if r["system_ref"] and r["talkgroup_ref"]]
        print(f"{len(rows)} talkgroups read from {src}")
    else:
        host = (env.get("TLR_HOST") or "").rstrip("/")
        key = (env.get("TLR_API_KEY") or "").strip()
        if not host or not key:
            sys.exit("Set TLR_HOST and TLR_API_KEY in the environment or in .env (never commit .env).")
        print(f"Reading calls from the last {hours:g} h ...")
        seen = fetch(host, key, int((time.time() - hours * 3600) * 1000), max_pages, float(arg("--delay", "1.5")))
        rows = sorted(seen.values(), key=lambda e: (e["system"].lower(), e["label"].lower()))
        out = local / "channels-seen.csv"
        with out.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=["system", "label", "name", "system_ref", "talkgroup_ref", "calls"], lineterminator="\n")
            w.writeheader()
            w.writerows(rows)
        print(f"{len(rows)} channels -> {out}")

    if "--fill" not in sys.argv:
        return
    key_path = local / "channels.csv"
    if not key_path.exists():
        sys.exit(f"{key_path} not found")
    with key_path.open(newline="", encoding="utf-8") as f:
        table = list(csv.reader(f))
    head = table[0]
    for col in ("system_ref", "talkgroup_ref"):
        if col not in head:
            head.append(col)
            for r in table[1:]:
                r.append("")
    ix = {c: i for i, c in enumerate(head)}
    for r in table[1:]:
        while len(r) < len(head):
            r.append("")

    by_name = {}
    for e in rows:
        for nm in {e["label"], e["name"]}:
            if nm:
                by_name.setdefault((norm(e["system"]), norm(nm)), []).append(e)

    force = "--force" in sys.argv
    filled, kept, missing, ambiguous = 0, 0, [], []
    for r in table[1:]:
        if not any(r):
            continue
        if r[ix["system_ref"]] and r[ix["talkgroup_ref"]] and not force:
            kept += 1
            continue
        names = [r[ix["label"]]] + [x for x in r[ix.get("also_matches", ix["label"])].split(";") if x.strip()]
        found = {}
        for nm in names:
            for e in by_name.get((norm(r[ix["system"]]), norm(nm)), []):
                found[(e["system_ref"], e["talkgroup_ref"])] = e
        label = f'{r[ix["system"]]} / {r[ix["label"]]}'
        if len(found) == 1:
            e = next(iter(found.values()))
            r[ix["system_ref"]], r[ix["talkgroup_ref"]] = e["system_ref"], e["talkgroup_ref"]
            filled += 1
        elif found:
            ambiguous.append(f"{label}: " + ", ".join(f"[{a}/{b}]" for a, b in found))
        else:
            missing.append(label)
    with key_path.open("w", newline="", encoding="utf-8") as f:
        csv.writer(f, lineterminator="\n").writerows(table)
    print(f"channels.csv: {filled} filled, {kept} already had refs, {len(missing)} not seen, {len(ambiguous)} ambiguous")
    for a in ambiguous:
        print("  ambiguous (fill by hand from channels-seen.csv):", a)
    for m in missing:
        print("  not found" + (" in the export:" if src else " in the window:"), m)


if __name__ == "__main__":
    main()
