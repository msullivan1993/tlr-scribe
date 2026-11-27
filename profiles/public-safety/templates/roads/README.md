# Road files

One file per county in `local/counties.txt`, built from OpenStreetMap by `tools/fetch_roads.py`: roads, route names, places, addressed places, interstate exits and mile posts, road points and intersections (with coordinates, for map images). The agent searches these during the ROAD CHECK; a road appears in a post only if it is in its county's file.

## Building and refreshing (fast way: downloaded state files)
1. Once: `py -m pip install osmium shapely`
2. Download each state you cover from [Geofabrik](https://download.geofabrik.de/north-america/us.html), the `.osm.pbf` file (e.g. `kentucky-latest.osm.pbf`), into a folder such as `C:\osm`.
3. Build into a test folder first:
   ```powershell
   py tools\fetch_roads.py --pbf C:\osm\kentucky-latest.osm.pbf --pbf C:\osm\ohio-latest.osm.pbf --out C:\temp\roads-test
   ```
   One `--pbf` per state, all in one command: counties near a state line get roads from every file that covers them. A county whose boundary isn't complete in the downloads gets just its boundary from Overpass automatically.
4. Compare a county or two with your current files: `fc C:\temp\roads-test\boyd-ky.txt local\roads\boyd-ky.txt` (Linux/macOS: `diff`). Only the "built" date should differ, plus whatever OpenStreetMap changed since your last build.
5. Build for real (same command without `--out`), then commit: `git add local/roads`, `git commit -m "Road files rebuilt"`, `git push`.

Refresh every month or two, or when you notice OpenStreetMap has roads your files lack. A whole state takes a few minutes.

## Slow way (no downloads)
`py tools\fetch_roads.py` asks the public Overpass API county by county. It needs no extra packages but can take hours for many counties. `py tools\fetch_roads.py Boyd:KY` builds one county.

## Your own fixes
Put them in `local/roads/manual/<county>-<st>.txt`; they are merged into every build, either way. Never edit the generated files: a rebuild overwrites them.
```
Big Bend Road                                   a road the map is missing
Russell Road = US 23                            a local name for a route
place: Hurricane Branch                         a missing community
addr: 1301 Madison Avenue = Madison Manor Apartments (apartments)
exit: I 64 191 = US 23; Catlettsburg            a missing interstate exit
```
After editing only a manual file: `py tools\fetch_roads.py --manual-only` re-merges without downloading.

Road data © OpenStreetMap contributors, ODbL.
