// Safety limits the Worker enforces on its own: CSRF, AUTO_POST switch, minimum delay, caps, token fallback, signed images.
import assert from "assert";
import { DatabaseSync } from "node:sqlite";
import fs from "fs";
const W = (await import("./worker.mjs")).default;
const sq = new DatabaseSync(":memory:");
function stmt(sql, args = []) { return { bind: (...a) => stmt(sql, a), _sql: sql, _args: args,
  async first() { const s = sq.prepare(sql); return (/RETURNING|^\s*SELECT/i.test(sql) ? s.get(...args) : (s.run(...args), null)) ?? null; },
  async all() { return { results: sq.prepare(sql).all(...args) }; }, async run() { sq.prepare(sql).run(...args); return {}; } }; }
const DB = { prepare: (sql) => stmt(sql), async batch(list) { for (const s of list) sq.prepare(s._sql).run(...s._args); return []; } };
const kv = new Map();
const SEEN = { async get(k) { return kv.get(k) ?? null; }, async put(k, v) { kv.set(k, String(v)); }, async delete(k) { kv.delete(k); }, async list() { return { keys: [] }; } };
let photoUrl = null, published = 0;
globalThis.fetch = async (u, init = {}) => {
  u = String(u);
  if (u.startsWith("https://graph.facebook.com/")) {
    const params = new URLSearchParams(init.body || u.split("?")[1] || "");
    if (u.includes("/photos")) { photoUrl = params.get("url"); published++; return new Response(JSON.stringify({ id: "x", post_id: "P_" + published })); }
    if (u.includes("/feed")) { published++; return new Response(JSON.stringify({ id: "P_" + published })); }
    return new Response(JSON.stringify({ permalink_url: "https://fb/x", message: "" }));
  }
  return new Response("PNG");
};
const base = { DB, SEEN, MCP_SECRET: "s", FB_PAGE_ID: "PAGE", FB_PAGE_TOKEN: "tok", IMAGE_KEY: "imgkey", IMAGE_BASE: "https://img.example/map.png", REVIEW_TOKEN: "rt", TLR_SECRET: "t" };
let env = { ...base };
const mcp = async (name, args) => { const r = await W.fetch(new Request("https://x/mcp", { method: "POST", headers: { Authorization: "Bearer s" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env, {}); const j = await r.json(); const t = j.result.content[0].text; return j.result.isError ? "ERR " + t : JSON.parse(t); };
const cron = () => new Promise((res) => { const p = []; W.scheduled({}, { ...env, POLL: "off" }, { waitUntil: (x) => p.push(x) }); Promise.all(p).then(res); });
const footer = "\n\nInformation is from live scanner transcriptions.\n🎧 Listen live ➜ scanner.example.com";
const T = (s) => `🔥 Structure Fire · ${s}\nMain Street · Nov 27, 2026, 3:00 AM\n\nCrews are responding.` + footer;

// 1. AUTO_POST off (default): a scheduled request becomes a draft
let c = await mcp("post_create", { text: T("A"), auto_post_minutes: 0.001 });
assert.equal(c.state, "draft");
// 2. AUTO_POST on: minimum delay is AUTO_POST_DELAY_MINUTES (5)
env = { ...base, AUTO_POST: "on" };
c = await mcp("post_create", { text: T("B"), auto_post_minutes: 0.001 });
assert.equal(c.state, "scheduled");
const at = sq.prepare("SELECT auto_post_at, created_at FROM posts WHERE id = ?").get(c.id);
assert.ok(at.auto_post_at - at.created_at >= 5 * 60000 - 10);
// 3. caps: 2 per hour; the third due auto-post becomes a draft
env = { ...base, AUTO_POST: "on", AUTO_POST_MAX_PER_HOUR: "2" };
const ids = [c.id, (await mcp("post_create", { text: T("C"), auto_post_minutes: 5, image: { e: "🔥", l1: "FIRE", mode: "town", q: "Ashland, KY" } })).id, (await mcp("post_create", { text: T("D"), auto_post_minutes: 5 })).id];
sq.prepare("UPDATE posts SET auto_post_at = 0 WHERE state = 'scheduled'").run();
await cron();
const states = ids.map((id) => sq.prepare("SELECT state FROM posts WHERE id = ?").get(id).state);
assert.deepEqual(states.sort(), ["draft", "published", "published"]);
// 4. signed image URL sent to Facebook: no key, has sig, and the image Worker accepts it
assert.ok(photoUrl && !photoUrl.includes("imgkey") && /[?&]sig=[0-9a-f]{40}/.test(photoUrl), photoUrl);
const iw = fs.readFileSync("../imageworker/src/index.js", "utf8");
const authSrc = iw.slice(iw.indexOf("async function authorized"), iw.indexOf("export default {"));
const { authorized } = await import("data:text/javascript," + encodeURIComponent(authSrc + "\nexport { authorized };"));
const pu = new URL(photoUrl);
assert.equal(await authorized(pu.searchParams, { IMAGE_KEY: "imgkey" }), true);
pu.searchParams.set("q", "somewhere else"); assert.equal(await authorized(pu.searchParams, { IMAGE_KEY: "imgkey" }), false);
assert.equal(await authorized(new URLSearchParams("key=imgkey&q=x"), { IMAGE_KEY: "imgkey", IMAGE_REQUIRE_SIG: "on" }), false);
// 5. CSRF: no X-Scribe header, wrong content type, or cross-site -> 403
const rv = (path, body, headers) => W.fetch(new Request("https://x/review/api/" + path, { method: body ? "POST" : "GET", headers: { Cookie: "scribe_review=rt", ...headers }, body: body ? JSON.stringify(body) : undefined }), env, {});
const draft = sq.prepare("SELECT id, version FROM posts WHERE state = 'draft' LIMIT 1").get();
assert.equal((await rv("publish", { id: draft.id, version: draft.version }, { "Content-Type": "text/plain" })).status, 403);
assert.equal((await rv("publish", { id: draft.id, version: draft.version }, { "Content-Type": "text/plain", "X-Scribe": "1" })).status, 403);
assert.equal((await rv("publish", { id: draft.id, version: draft.version }, { "Content-Type": "application/json", "X-Scribe": "1", "Sec-Fetch-Site": "cross-site" })).status, 403);
assert.equal((await rv("list", null, {})).status, 403);
assert.equal((await rv("list", null, { "X-Scribe": "1" })).status, 200);
// 6. REVIEW_TOKEN is ignored once Access is configured (unless REVIEW_TOKEN_FALLBACK=on)
env = { ...base, ACCESS_TEAM: "team", ACCESS_AUD: "aud" };
assert.notEqual((await rv("list", null, { "X-Scribe": "1" })).status, 200);
env = { ...base, ACCESS_TEAM: "team", ACCESS_AUD: "aud", REVIEW_TOKEN_FALLBACK: "on" };
assert.equal((await rv("list", null, { "X-Scribe": "1" })).status, 200);
// 7. talker-alias labels are sanitised
const src = fs.readFileSync("worker.mjs", "utf8");
assert.ok(src.includes('.replace(/[^A-Za-z0-9 .\\/-]/g, "")'));
console.log("security ok");
