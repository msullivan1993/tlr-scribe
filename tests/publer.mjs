// PUBLISHER=publer: publish through Publer (media upload job, publish job, find post id), live update, daily limit.
import assert from "assert";
import { DatabaseSync } from "node:sqlite";
const W = (await import("./worker.mjs")).default;
const sq = new DatabaseSync(":memory:");
function stmt(sql, args = []) { return { bind: (...a) => stmt(sql, a), _sql: sql, _args: args,
  async first() { const s = sq.prepare(sql); return (/RETURNING|^\s*SELECT/i.test(sql) ? s.get(...args) : (s.run(...args), null)) ?? null; },
  async all() { return { results: sq.prepare(sql).all(...args) }; }, async run() { sq.prepare(sql).run(...args); return {}; } }; }
const DB = { prepare: (sql) => stmt(sql), async batch(list) { for (const s of list) sq.prepare(s._sql).run(...s._args); return []; } };
const kv = new Map();
const SEEN = { async get(k) { return kv.get(k) ?? null; }, async put(k, v) { kv.set(k, String(v)); }, async delete(k) { kv.delete(k); }, async list() { return { keys: [] }; } };
const log = []; let published = []; let edits = {};
globalThis.fetch = async (u, init = {}) => {
  u = String(u);
  if (u.startsWith("https://app.publer.com/api/v1")) {
    const path = u.slice("https://app.publer.com/api/v1".length);
    const body = init.body ? JSON.parse(init.body) : null;
    log.push(`${init.method || "GET"} ${path.split("?")[0]}`);
    assert.equal(init.headers.Authorization, "Bearer-API pk");
    assert.equal(init.headers["Publer-Workspace-Id"], "ws");
    if (path === "/media/from-url") return new Response(JSON.stringify({ job_id: "jm" }));
    if (path === "/job_status/jm") return new Response(JSON.stringify({ success: true, data: { status: "complete", result: { status: "complete", payload: [{ id: "media1", path: "https://cdn/x.png", type: "photo" }] } } }));
    if (path === "/posts/schedule/publish") {
      const net = body.bulk.posts[0].networks.default;
      published = body.bulk.posts[0].accounts.map((a, i) => ({ id: "pp" + i, text: net.text, post_link: i ? null : "https://facebook.com/p/1", media: net.media }));
      return new Response(JSON.stringify({ job_id: "jp" }));
    }
    if (path === "/job_status/jp") return new Response(JSON.stringify({ status: "complete", payload: { failures: {} } }));
    if (path.startsWith("/posts?state=published_posted")) return new Response(JSON.stringify({ posts: published }));
    if (path.startsWith("/posts/pp") && init.method === "PUT") { edits[path.slice(7)] = body.post.text; return new Response(JSON.stringify({ success: true })); }
    if (path === "/accounts") return new Response(JSON.stringify([]));
    return new Response(JSON.stringify({ errors: ["unexpected " + path] }), { status: 404 });
  }
  if (u.startsWith("https://graph.facebook.com/")) throw new Error("Graph API must not be called with PUBLISHER=publer");
  return new Response("{}", { status: 200 });
};
const env = { DB, SEEN, MCP_SECRET: "s", REVIEW_TOKEN: "rt", TLR_SECRET: "t", IMAGE_KEY: "ik", IMAGE_BASE: "https://img.example/map.png",
  PUBLISHER: "publer", PUBLER_KEY: "pk", PUBLER_WORKSPACE: "ws", PUBLER_ACCOUNTS: "acc1, acc2", PUBLER_DAILY_LIMIT: "2" };
const mcp = async (name, args) => { const r = await W.fetch(new Request("https://x/mcp", { method: "POST", headers: { Authorization: "Bearer s" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env, {}); const j = await r.json(); const t = j.result.content[0].text; return j.result.isError ? "ERR " + t : JSON.parse(t); };
const rv = async (path, body) => { const r = await W.fetch(new Request("https://x/review/api/" + path, { method: body ? "POST" : "GET", headers: { Cookie: "scribe_review=rt", "X-Scribe": "1", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env, {}); return [r.status, await r.json()]; };

const list = (await rv("list"))[1];
assert.equal(list.facebook, "connected"); assert.equal(list.publisher, "Publer");
const footer = "\n\nInformation is from live scanner transcriptions and may not be complete or accurate.\n🎧 Listen live ➜ scanner.example.com";
const text = "🔥 Structure Fire · Ashland, Boyd County, KY\n1200 block of Winchester Avenue · Nov 26, 2026, 2:00 AM\n\nAshland FD is responding." + footer;
const c = await mcp("post_create", { text, image: { e: "🔥", l1: "FIRE", mode: "town", q: "Ashland, KY" } });
const pub = await rv("publish", { id: c.id, version: c.version });
assert.equal(pub[0], 200, JSON.stringify(pub));
const row = sq.prepare("SELECT state, fb_id, fb_url FROM posts WHERE id = ?").get(c.id);
assert.equal(row.state, "published"); assert.equal(row.fb_id, "publer:pp0,pp1"); assert.equal(row.fb_url, "https://facebook.com/p/1");
assert.deepEqual(published[0].media, [{ id: "media1", type: "image" }]);
const cur = (await mcp("post_list", {})).posts.find((p) => p.id === c.id);
const up = await mcp("post_update", { id: c.id, version: cur.version, text: cur.text.replace(footer, "\n\nUPDATE 2:10 AM: Fire is out." + footer) });
// a rewrite of a live post is refused
const cur2 = (await mcp("post_list", {})).posts.find((p) => p.id === c.id);
assert.ok(String(await mcp("post_update", { id: c.id, version: cur2.version, text: "🔥 Totally different\n" + "x".repeat(900) + footer })).includes("refused"));
assert.ok(!String(up).startsWith("ERR"), up);
assert.ok(edits.pp0.includes("Fire is out") && edits.pp1.includes("Fire is out"));
// daily limit (2): one more publishes, the third is refused
const c2 = await mcp("post_create", { text: text.replace("Ashland FD", "Second") });
assert.equal((await rv("publish", { id: c2.id, version: c2.version }))[0], 200);
const c3 = await mcp("post_create", { text: text.replace("Ashland FD", "Third") });
const r3 = await rv("publish", { id: c3.id, version: c3.version });
assert.notEqual(r3[0], 200); assert.ok(JSON.stringify(r3[1]).includes("daily limit"), JSON.stringify(r3));
console.log("publer ok:", log.filter((x, i, a) => a.indexOf(x) === i).join(" | "));
