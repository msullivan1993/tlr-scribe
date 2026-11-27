import { DatabaseSync } from "node:sqlite";
const W = (await import("./worker.mjs")).default;
const sq = new DatabaseSync(":memory:");
function stmt(sql, args = []) { return { bind: (...a) => stmt(sql, a), _sql: sql, _args: args,
  async first() { const s = sq.prepare(sql); return (/RETURNING|^\s*SELECT/i.test(sql) ? s.get(...args) : (s.run(...args), null)) ?? null; },
  async all() { return { results: sq.prepare(sql).all(...args) }; }, async run() { sq.prepare(sql).run(...args); return {}; } }; }
const DB = { prepare: (sql) => stmt(sql), async batch(list) { for (const s of list) sq.prepare(s._sql).run(...s._args); return []; } };
const kv = new Map();
const SEEN = { async get(k) { return kv.get(k) ?? null; }, async put(k, v) { kv.set(k, String(v)); }, async delete(k) { kv.delete(k); }, async list() { return { keys: [] }; } };
let fbText = {}; let fbLog = [];
globalThis.fetch = async (u, init = {}) => {
  u = String(u);
  if (u.startsWith("https://graph.facebook.com/")) {
    const path = u.split("/").slice(4).join("/").split("?")[0];
    const params = new URLSearchParams(init.body || u.split("?")[1] || "");
    fbLog.push(`${init.method || "GET"} ${path}`);
    if (path.endsWith("/photos")) { fbText["P_1"] = params.get("message"); return new Response(JSON.stringify({ id: "photo1", post_id: "P_1" })); }
    if (path.endsWith("/feed")) { fbText["P_2"] = params.get("message"); return new Response(JSON.stringify({ id: "P_2" })); }
    if ((init.method || "GET") === "GET") { const f = params.get("fields"); return new Response(JSON.stringify(f === "message" ? { message: fbText[path] } : { permalink_url: "https://fb/" + path })); }
    fbText[path] = params.get("message"); return new Response(JSON.stringify({ success: true }));
  }
  if (u.includes("map.png")) return new Response("PNG", { headers: { "Content-Type": "image/png" } });
  return new Response("{}", { status: 200 });
};
const env = { DB, SEEN, MCP_SECRET: "s", FB_PAGE_ID: "PAGE", FB_PAGE_TOKEN: "tok", IMAGE_KEY: "ik", REVIEW_TOKEN: "rt", TLR_SECRET: "t" };
const mcp = async (name, args) => { const r = await W.fetch(new Request("https://x/mcp", { method: "POST", headers: { Authorization: "Bearer s" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env, {}); const j = await r.json(); const t = j.result.content[0].text; return j.result.isError ? "ERR " + t : JSON.parse(t); };
const rv = async (path, body) => { const r = await W.fetch(new Request("https://x/review/api/" + path, { method: body ? "POST" : "GET", headers: { Cookie: "scribe_review=rt" }, body: body ? JSON.stringify(body) : undefined }), env, {}); return [r.status, r.headers.get("Content-Type").includes("json") ? await r.json() : await r.text()]; };
const tl = await (await W.fetch(new Request("https://x/mcp", { method: "POST", headers: { Authorization: "Bearer s" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), env, {})).json();
console.log("tools:", tl.result.tools.map((t) => t.name).join(","));
const text1 = "🔥 Structure Fire · Ashland, Boyd County, KY\n1200 block of Winchester Avenue · Nov 26, 2026, 2:00 AM\n\nAshland FD is responding.\n\nInformation is from live scanner transcriptions and may not be complete or accurate.";
const c1 = await mcp("post_create", { text: text1, image: { e: "🔥", l1: "POSSIBLE STRUCTURE FIRE", l3: "Ashland, Boyd Co, KY", mode: "block", q: "1200 Winchester Ave, Ashland, KY" } });
console.log("create:", c1);
console.log("owner save:", await rv("save", { id: c1.id, version: 1, text: text1.replace("Ashland FD", "Ashland Fire Department") }));
console.log("bot stale update:", (await mcp("post_update", { id: c1.id, version: 1, text: text1 + "\nUPDATE 2:05 AM: x" })).slice(0, 90));
const pl = await mcp("post_list", {});
const cur = pl.posts.find((p) => p.id === c1.id);
console.log("bot fresh update:", await mcp("post_update", { id: c1.id, version: cur.version, text: cur.text.replace("responding.", "responding.\n\nUPDATE 2:05 AM: Crews report smoke showing.") }));
const p = (await rv("post?id=" + c1.id))[1];
console.log("versions:", p.versions.map((v) => `v${v.version}:${v.by}`).join(" "), "owner_edited:", p.owner_edited);
console.log("publish stale:", (await rv("publish", { id: c1.id, version: 1 }))[0]);
console.log("publish:", await rv("publish", { id: c1.id, version: p.version, text: p.text }));
console.log("fb:", fbLog.join(" | "));
// owner edits on Facebook, then bot updates with the old version
fbText["P_1"] = fbText["P_1"] + "\n(owner fix on FB)";
const pl2 = (await mcp("post_list", {})).posts.find((x) => x.id === c1.id);
console.log("bot update after FB edit:", String(await mcp("post_update", { id: c1.id, version: pl2.version, text: pl2.text + "\nUPDATE 2:20 AM: Fire out." })).slice(0, 100));
const pl3 = (await mcp("post_list", {})).posts.find((x) => x.id === c1.id);
console.log("text now has owner fix:", pl3.text.includes("owner fix"), "v", pl3.version);
console.log("bot retry:", await mcp("post_update", { id: c1.id, version: pl3.version, text: pl3.text + "\nUPDATE 2:20 AM: Fire out." }), "fb has both:", fbText["P_1"].includes("owner fix") && fbText["P_1"].includes("Fire out"));
// auto-post
const c2 = await mcp("post_create", { text: "🔥 Structure Fire · X\nY · Z\n\nWorking fire.", auto_post_minutes: 5 });
console.log("auto:", c2);
console.log("pull back:", await mcp("post_pull_back", { id: c2.id, reason: "test" }));
const c3 = await mcp("post_create", { text: "🔥 Structure Fire · Q\nY · Z\n\nWorking fire.", auto_post_minutes: 1 });
sq.prepare("UPDATE posts SET auto_post_at = 0 WHERE id = ?").run(c3.id);
await new Promise((res) => { const p = []; W.scheduled({}, { ...env, POLL: "off" }, { waitUntil: (x) => p.push(x) }); Promise.all(p).then(res); });
console.log("after cron:", sq.prepare("SELECT id, state, fb_id FROM posts").all().map((r) => `${r.id}:${r.state}:${r.fb_id || ""}`).join(" "));
console.log("supersede:", await mcp("post_supersede", { id: c2.id, reason: "dup of 1" }));
console.log("corrections:", (await rv("corrections", { heard: "GRACELAND", means: "Branchland" }))[0], (await mcp("get_work", {})).corrections);
console.log("list:", Object.entries((await rv("list"))[1]).map(([k, v]) => k + "=" + (Array.isArray(v) ? v.length : v)).join(" "));
console.log("image:", (await rv("image?l1=A&mode=town&q=Ashland"))[0]);
console.log("page:", (await W.fetch(new Request("https://x/review?token=rt"), env, {})).status, (await W.fetch(new Request("https://x/review"), env, {})).status);
console.log("off:", (await mcp.call(null, "post_list", {}, { ...env })) && "");
