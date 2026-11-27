// Smoke tests for the Worker. Run from the repository root:  node tests/run-all.mjs
// Each test runs worker/worker.js against an in-memory D1 (node:sqlite) and KV, with Facebook,
// Discord and Claude calls faked. A test fails when it throws or prints a ReferenceError/TypeError.
// Needs Node 22.5+ (node:sqlite). serve.mjs is not run here: it serves the review page on
// http://localhost:8787/review for clicking through by hand (node tests/serve.mjs).
import { copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
copyFileSync(join(here, "..", "worker", "worker.js"), join(here, "worker.mjs"));
let failed = 0;
for (const t of ["run", "ctx", "posts", "junk", "prayers", "wake", "urgent", "refs", "publer", "security", "geocode"]) {
  const r = spawnSync(process.execPath, ["--no-warnings", t + ".mjs"], { cwd: here, encoding: "utf8", timeout: 120000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const bad = r.status !== 0 || /ReferenceError|TypeError|SyntaxError/.test(out);
  if (bad) failed++;
  console.log(`${bad ? "FAIL" : "ok  "}  ${t}`);
  if (bad) console.log(out.split("\n").filter((l) => /Error/.test(l)).slice(0, 5).join("\n"));
}
process.exit(failed ? 1 : 0);
