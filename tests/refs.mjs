// System/talkgroup refs in alert headers and radio-batch lines.
import fs from "fs";
import assert from "assert";
fs.writeFileSync("refs_w.mjs", fs.readFileSync("worker.mjs", "utf8") + "\nexport { refsText, buildText };");
const { refsText, buildText } = await import("./refs_w.mjs");
assert.equal(refsText(21019, 1234), "[21019/1234]");
assert.equal(refsText(undefined, 1234), "[?/1234]");
assert.equal(refsText(null, null), "");
assert.equal(refsText(0, ""), "");
const env = { TIMEZONE: "America/New_York", PROMO: "off" };
const t = buildText({ message: "Boyd KY Public Safety / BCFIREPG — Ashland FD", timestamp: 1795760000000, transcription: "STRUCTURE FIRE 1200 WINCHESTER", metadata: { systemRef: 21019, talkgroupRef: 1234, units: [1201, 4410] } }, env);
assert.ok(t.split("\n")[0].endsWith("— Ashland FD [21019/1234]"), t);
assert.ok(t.includes("🆔 Units: 1201, 4410"), t);
const t2 = buildText({ message: "Boyd KY Public Safety / BCFIREPG", metadata: {} }, env);
assert.equal(t2.split("\n")[0], "🚨 Boyd KY Public Safety / BCFIREPG");
fs.unlinkSync("refs_w.mjs");
console.log("refs ok");
