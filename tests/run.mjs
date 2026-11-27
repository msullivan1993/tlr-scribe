import { DatabaseSync } from "node:sqlite";
const W = (await import("./worker.mjs")).default;
const sq = new DatabaseSync(":memory:");
// Minimal D1 shim
function stmt(sql, args = []) {
  return {
    bind: (...a) => stmt(sql, a),
    _sql: sql, _args: args,
    async first() { const s = sq.prepare(sql); const r = /RETURNING|^\s*SELECT/i.test(sql) ? s.get(...args) : (s.run(...args), null); return r ?? null; },
    async all() { const s = sq.prepare(sql); return { results: s.all(...args) }; },
    async run() { sq.prepare(sql).run(...args); return { success: true }; },
  };
}
const DB = { prepare: (sql) => stmt(sql), async batch(list) { const out = []; for (const s of list) { if (/RETURNING|^\s*SELECT/i.test(s._sql)) out.push({ results: sq.prepare(s._sql).all(...s._args) }); else { sq.prepare(s._sql).run(...s._args); out.push({ success: true }); } } return out; } };
const kv = new Map();
const SEEN = { async list({prefix=""}={}) { return { keys: [...kv.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})), list_complete: true }; }, async get(k) { return kv.get(k) ?? null; }, async put(k, v) { kv.set(k, String(v)); }, async delete(k) { kv.delete(k); } };
const env = { DB, SEEN, MCP_SECRET: "s3cret", TLR_SECRET: "t", STREETS: "off" };
globalThis.fetch = async (u) => { throw new Error("no network in test: " + u); };
const call = async (method, params, id = 1) => {
  const res = await W.fetch(new Request("https://x/mcp/s3cret", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }), env, {});
  return res.status === 202 ? null : await res.json();
};
const tool = async (name, args) => { const r = await call("tools/call", { name, arguments: args }); const t = r.result.content[0].text; return r.result.isError ? t : JSON.parse(t); };
console.log((await call("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo);
console.log("notif:", await call("notifications/initialized", {}, null));
console.log("tools:", (await call("tools/list", {})).result.tools.map((t) => t.name).join(","));
console.log("bad secret:", (await W.fetch(new Request("https://x/mcp/nope", { method: "POST", body: "{}" }), env, {})).status);
// alert via webhook path in d1 mode
const res = await W.fetch(new Request("https://x/", { method: "POST", headers: { "X-Webhook-Secret": "t" }, body: JSON.stringify({ message: "Boyd KY / BCFIREPG", timestamp: Date.now(), transcription: "STATION 93 RESPOND TO A STRUCTURE FIRE", metadata: { callId: 111, talkgroupLabel: "BCFIREPG", systemLabel: "Boyd KY" } }) }), env, { waitUntil() {} });
console.log("webhook:", res.status, (await res.text()).slice(0, 150));
console.log("dup:", await (async () => { const { storeItem } = {}; return "skip"; })());
let w = await tool("get_work", {});
console.log("work alerts:", w.new_alerts.map((a) => [a.id, a.text.slice(0, 60)]));
console.log("claim main:", await tool("claim", { ids: [1, 99], run: "main" }));
console.log("claim light:", await tool("claim", { ids: [1], run: "light" }));
w = await tool("get_work", {});
console.log("held:", w.claimed_by_another_run);
console.log("mark:", await tool("mark", { items: [{ id: 1, outcome: "new private draft: Structure Fire" }] }));
const inc = await tool("incident_save", { title: "🔥 Structure Fire · Ashland", post_ref: "abc", track: "Stations: 93" });
console.log("inc:", inc, await tool("incident_save", { id: inc.id, title: "🔥 Structure Fire · Ashland", track: "Stations: 93, 94" }));
console.log("recent:", (await tool("recent_items", { minutes: 10 })).items.map((i) => [i.id, i.outcome]));
kv.set("run:kind", "main");
console.log("runlog:", await tool("runlog_write", { run: "light", text: "No new alerts." }), "run:done after light:", kv.get("run:done") ?? "unset");
console.log("runlog:", await tool("runlog_write", { run: "main", text: "📋 RUNLOG 1:00 AM\n\nDid things." }), "run:done after main:", !!kv.get("run:done"));
console.log("storm:", await tool("storm_save", { text: "Storm calls: 2" }));
w = await tool("get_work", {});
console.log("work:", JSON.stringify({ open: w.open_incidents, storm: w.storm_tracker, last: w.last_runlog }).slice(0, 400));
console.log("end:", await tool("incident_end", { id: inc.id, note: "cleared" }), (await tool("get_work", {})).open_incidents.length);
console.log("release:", await tool("release", { ids: [5] }));
console.log("err:", await tool("incident_end", { id: 999 }));
const st = await W.fetch(new Request("https://x/status?secret=t"), env, { waitUntil() {} });
const sj = await st.json(); console.log("status:", st.status, JSON.stringify(sj.store || sj).slice(0, 300));
