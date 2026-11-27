# Road files

`python3 tools/fetch_roads.py` builds one file per county in `local/counties.txt` from OpenStreetMap
(roads, route names, intersections, road points, interstate exits, addressed places).

Your own fixes go in `local/roads/manual/<county>-<st>.txt` (one road or `Local Name = ROUTE` per line).
They are merged in on every rebuild, so never edit the generated files directly.

Rebuild after adding counties: `python3 tools/fetch_roads.py` (all) or `python3 tools/fetch_roads.py Boyd:KY` (one).
Road data © OpenStreetMap contributors, ODbL.
