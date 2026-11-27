import { DatabaseSync } from "node:sqlite";
const W = (await import("./worker.mjs")).default;
const sq = new DatabaseSync(":memory:");
function stmt(sql, args = []) { return { bind: (...a) => stmt(sql, a), _sql: sql, _args: args,
  async first() { const s = sq.prepare(sql); return (/RETURNING|^\s*SELECT/i.test(sql) ? s.get(...args) : (s.run(...args), null)) ?? null; },
  async all() { return { results: sq.prepare(sql).all(...args) }; }, async run() { sq.prepare(sql).run(...args); return {}; } }; }
const DB = { prepare: (sql) => stmt(sql), async batch(list) { for (const s of list) sq.prepare(s._sql).run(...s._args); return []; } };
const kv = new Map();
const SEEN = { async get(k) { return kv.get(k) ?? null; }, async put(k, v) { kv.set(k, String(v)); }, async delete(k) { kv.delete(k); }, async list() { return { keys: [] }; } };
let calls = [];
const now = Date.now();
globalThis.fetch = async (u) => {
  u = String(u);
  if (u.includes("/api/public/v1/transcripts")) return new Response(JSON.stringify({ results: calls }), { status: 200 });
  return new Response("no", { status: 500 });
};
const env = { DB, SEEN, MCP_SECRET: "s", TLR_SECRET: "t", TLR_HOST: "https://tlr", TLR_API_KEY: "k",
  POLL: "on", CONTEXT: "on", POLL_TALKGROUPS: "PFD-1", CONTEXT_TALKGROUPS: "PFD-1,LAW", POLL_KEYWORDS: "heavy smoke,structure fire", STREETS: "off", CONTEXT_EVERY_MINUTES: "1", NOTIFY: "off", WEATHER: "off", CLEANUP: "off" };
kv.set("ctx:lastAlertAt", String(now - 5 * 60000));
const run = async () => { await new Promise((res) => { const p = []; W.scheduled({}, env, { waitUntil: (x) => p.push(x) }); Promise.all(p).then(res); }); };
calls = [
  { callId: 1, timestamp: now - 4 * 60000, talkgroupLabel: "LAW", systemLabel: "Scioto", transcript: "UNIT 5 ON SCENE AT THE FIRE WITH TRAFFIC CONTROL NOW" },
  { callId: 3, timestamp: now - 2 * 60000, talkgroupLabel: "LAW", systemLabel: "Scioto", transcript: "UNIT 6 BLOCKING THE ROAD AT GALLIA STREET RIGHT NOW" },
];
await run();
// late transcription: call 2 is older than call 3 but arrives now; plus a keyword line on a poll channel
calls.push({ callId: 2, timestamp: now - 3 * 60000, talkgroupLabel: "LAW", systemLabel: "Scioto", transcript: "LATE LINE THAT WAS TRANSCRIBED AFTER THE OTHERS ARRIVED" });
calls.push({ callId: 4, timestamp: now - 3 * 60000, talkgroupLabel: "PFD-1", systemLabel: "Scioto", transcript: "BATTALION 1 IS ON SCENE HEAVY SMOKE SHOWING CONFIRMING" });
await run();
await run(); // nothing new: no duplicate batch
const rows = sq.prepare("SELECT id, kind, call_id, urgent, substr(body, 1, 400) AS b FROM items").all();
for (const r of rows) console.log(r.id, r.kind, r.call_id, "urgent=" + r.urgent, JSON.stringify(r.b).slice(0, 260));
