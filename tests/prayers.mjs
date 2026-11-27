import { DatabaseSync } from "node:sqlite";
const W = (await import("./worker.mjs")).default;
const sq = new DatabaseSync(":memory:");
function stmt(sql, args = []) { return { bind: (...a) => stmt(sql, a), _sql: sql, _args: args,
  async first() { const s = sq.prepare(sql); return (/RETURNING|^\s*SELECT/i.test(sql) ? s.get(...args) : (s.run(...args), null)) ?? null; },
  async all() { return { results: sq.prepare(sql).all(...args) }; }, async run() { sq.prepare(sql).run(...args); return {}; } }; }
const DB = { prepare: (s) => stmt(s), async batch(l) { for (const s of l) sq.prepare(s._sql).run(...s._args); return []; } };
const kv = new Map();
const SEEN = { async list() { return { keys: [], list_complete: true }; }, async get(k) { return kv.get(k) ?? null; }, async put(k, v) { kv.set(k, String(v)); }, async delete(k) { kv.delete(k); } };
const env = { DB, SEEN, FB_PAGE_ID: "P", FB_PAGE_TOKEN: "t", DISCORD_WEBHOOK_PRAYERS: "https://discord.com/api/webhooks/1/abc", TIMEZONE: "America/New_York", REVIEW_TOKEN: "rt" };
let comments = ["Prayers 🙏", "praying for everyone", "🙏🙏", "Where is this?", "Prayers for the family", "That road is dangerous", "prayin"];
const disc = [];
globalThis.fetch = async (u, init = {}) => { u = String(u);
  if (u.includes("discord")) { disc.push(init.method + " " + u.replace(/.*webhooks\/1\/abc/, "")); return new Response(JSON.stringify({ id: "M1" }), { status: 200 }); }
  if (u.includes("/P/posts")) return new Response(JSON.stringify({ data: [{ id: "P_1", message: "🚗 Vehicle Crash · Hardy, Pike County, KY\nKY 319", created_time: new Date().toISOString(), comments: { summary: { total_count: comments.length } } }, { id: "P_2", message: "🔥 Structure Fire · Ashland, Boyd County, KY", created_time: new Date().toISOString(), comments: { summary: { total_count: 0 } } }] }));
  if (u.includes("/P_1/comments")) return new Response(JSON.stringify({ data: comments.map((m) => ({ message: m })) }));
  throw new Error("net " + u); };
const run = () => W.scheduled({}, env, { waitUntil: (p) => p });
const api = async () => (await W.fetch(new Request("http://x/review/api/prayers", { headers: { cookie: "scribe_review=rt" } }), env, {})).json();
// call prayerCheck through scheduled; other crons will error harmlessly
await run(); await new Promise(r => setTimeout(r, 200));
console.log(JSON.stringify(await api()).slice(0, 400)); console.log("discord:", disc);
comments.push("Prayers"); kv.delete("prayer:last"); await run(); await new Promise(r => setTimeout(r, 200));
console.log("discord:", disc);
kv.delete("prayer:last"); await run(); await new Promise(r => setTimeout(r, 200)); console.log("discord (no change):", disc.length);
// backfill: 2 pages of old posts
let pg = 0;
const of = globalThis.fetch;
globalThis.fetch = async (u, init = {}) => { u = String(u);
  if (u.includes("/P/posts") && !u.includes("since=")) { pg++; const after = pg === 1;
    return new Response(JSON.stringify({ data: [{ id: "OLD_" + pg, message: "🚗 Vehicle Crash · Old " + pg, created_time: "2024-0" + pg + "-01T12:00:00Z", comments: { summary: { total_count: 2 } } }], paging: after ? { next: "https://graph.facebook.com/v25.0/P/posts?limit=25&until=1700000000&__paging_token=abc&access_token=t" } : { previous: "y" } })); }
  if (false) { }
  if (u.includes("/OLD_")) return new Response(JSON.stringify({ data: [{ message: "Prayers" }, { message: "ok" }] }));
  return of(u, init); };
await W.fetch(new Request("http://x/review/api/prayers?scan=start", { headers: { cookie: "scribe_review=rt" } }), env, {});
for (let i = 0; i < 3; i++) { await run(); await new Promise(r => setTimeout(r, 150)); }
console.log("kv bf:", kv.get("prayer:bf"));
const a2 = await api(); console.log("scan:", JSON.stringify(a2.scan), "all:", JSON.stringify(a2.all)); console.log("discord:", disc);
