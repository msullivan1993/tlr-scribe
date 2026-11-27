import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
const W = (await import("./worker.mjs")).default;
const sq = new DatabaseSync(":memory:");
function stmt(sql, args = []) { return { bind: (...a) => stmt(sql, a), _sql: sql, _args: args,
  async first() { const s = sq.prepare(sql); return (/RETURNING|^\s*SELECT/i.test(sql) ? s.get(...args) : (s.run(...args), null)) ?? null; },
  async all() { return { results: sq.prepare(sql).all(...args) }; }, async run() { sq.prepare(sql).run(...args); return {}; } }; }
const DB = { prepare: (sql) => stmt(sql), async batch(list) { for (const s of list) sq.prepare(s._sql).run(...s._args); return []; } };
const kv = new Map();
const SEEN = { async get(k) { return kv.get(k) ?? null; }, async put(k, v) { kv.set(k, String(v)); }, async delete(k) { kv.delete(k); } };
// a 1x1 PNG stands in for the map image
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => { u = String(u); if (u.includes("map.png")) return new Response(png, { headers: { "Content-Type": "image/png" } }); return new Response("{}"); };
const env = { DB, SEEN, STORE: "d1", REVIEW: "on", MCP_SECRET: "s", FB_PAGE_ID: "P", FB_PAGE_TOKEN: "t", IMAGE_KEY: "k", REVIEW_TOKEN: "rt" };
const mcp = async (name, args) => (await W.fetch(new Request("http://x/mcp", { method: "POST", headers: { Authorization: "Bearer s" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env, {})).json();
await mcp("post_create", { text: "🚗 Vehicle Crash · Boyd County, KY\nI-64 eastbound, MM 191 · Nov 25, 2026, 9:53 PM\n\nEngland Hill VFD and Cannonsburg VFD are responding to a crash involving a deputy's vehicle and a deer on I-64 eastbound at MM 191.\n\nUPDATE 10:02 PM: The deputy's vehicle is disabled on the eastbound side.\n\nInformation is from live scanner transcriptions and may not be complete or accurate.\n🎧 Listen to live scanner traffic ➜ scanner.example.com", image: { e: "🚗", l1: "VEHICLE CRASH", l2: "I-64 EB, MM 191", l3: "Boyd Co, KY", mode: "mile", lat: "38.38039", lon: "-82.60720" } });
await mcp("post_create", { text: "🔥 Structure Fire · Ashland, Boyd County, KY\nWinchester Avenue · Nov 26, 2026, 2:00 AM\n\nAshland FD is responding to a working fire.", auto_post_minutes: 4 });
http.createServer(async (req, res) => {
  if (req.url.startsWith("/__bump")) { const v = Number(new URL(req.url, "http://x").searchParams.get("v")); const o = await mcp("post_update", { id: 1, version: v, text: "BUMPED v" + v + "\nline2" }); res.end(JSON.stringify(o)); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await W.fetch(new Request("http://localhost:8787" + req.url, { method: req.method, headers: { ...req.headers, cookie: "scribe_review=rt", "x-scribe": "1" }, body: chunks.length ? Buffer.concat(chunks) : undefined }), env, {});
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8787, () => console.log("up"));
