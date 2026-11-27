"""
Put the review page (worker/review.html) into the Worker (worker/worker.js) as REVIEW_HTML.
Edit worker/review.html, run this, then paste worker/worker.js into Cloudflare and deploy.
  python tools/build_worker.py          (from the repository root)
"""
import json
from pathlib import Path

html = Path("worker/review.html").read_text(encoding="utf-8")
js_path = Path("worker/worker.js")
js = js_path.read_text(encoding="utf-8")
start = js.index("const REVIEW_HTML = ")
end = js.index("\n", start)
new = js[:start] + "const REVIEW_HTML = " + json.dumps(html, ensure_ascii=False) + ";" + js[end:]
if new != js:
    js_path.write_text(new, encoding="utf-8", newline="\n")
    print("worker/worker.js updated with worker/review.html")
else:
    print("already up to date")
