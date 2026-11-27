import { DatabaseSync } from "node:sqlite";
const W = (await import("./worker.mjs")).default;
const sq = new DatabaseSync(":memory:");
function stmt(sql, args = []) { return { bind: (...a) => stmt(sql, a), _sql: sql, _args: args,
  async first() { const s = sq.prepare(sql); return (/RETURNING|^\s*SELECT/i.test(sql) ? s.get(...args) : (s.run(...args), null)) ?? null; },
  async all() { return { results: sq.prepare(sql).all(...args) }; }, async run() { sq.prepare(sql).run(...args); return { success: true }; } }; }
const DB = { prepare: (s) => stmt(s), async batch(l) { const o=[]; for (const s of l) { if (/RETURNING|^\s*SELECT/i.test(s._sql)) o.push({results: sq.prepare(s._sql).all(...s._args)}); else { sq.prepare(s._sql).run(...s._args); o.push({success:true}); } } return o; } };
const kv = new Map();
const SEEN = { async list({prefix=""}={}) { return { keys: [...kv.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})), list_complete: true }; }, async get(k) { return kv.get(k) ?? null; }, async put(k, v) { kv.set(k, String(v)); }, async delete(k) { kv.delete(k); } };
const env = { DB, SEEN, TLR_SECRET: "t", CLAUDE_FIRE_URL: "https://fire/x", CLAUDE_FIRE_TOKEN: "k", WAKE_EVERY_MINUTES: "10", STREETS: "off" };
let fires = 0; globalThis.fetch = async (u) => { if (String(u).startsWith("https://fire")) { fires++; return new Response("{}", { status: 200 }); } throw new Error("net " + u); };
let now = Date.now(); const realNow = Date.now; Date.now = () => now;
const post = async (id, text) => { const r = await W.fetch(new Request("https://x/", { method: "POST", headers: { "X-Webhook-Secret": "t", "content-type": "application/json" }, body: JSON.stringify({ message: "Boyd / Fire", transcription: text, timestamp: now, metadata: { callId: id, talkgroupLabel: "Fire" } }) }), env, { waitUntil: (p) => p }); await new Promise(r => setTimeout(r, 50)); };
await post(1, "MEDIC 2 RESPOND CHEST PAIN"); console.log("t0 routine fires:", fires);
kv.set("run:done", String(now + 1)); // run finished
now += 4 * 60000; await post(2, "CAR VS DEER NO INJURIES"); console.log("t+4 routine fires:", fires, "pending:", kv.get("wake:pending"));
now += 0; await post(3, "STRUCTURE FIRE 1200 WINCHESTER"); console.log("t+4 urgent fires:", fires, "pending:", kv.get("wake:pending"));
