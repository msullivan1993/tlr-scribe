// Image Worker geocoding: results outside the incident's county are not used; Census backs up Mapbox for addresses.
import assert from "assert";
import fs from "fs";
let src = fs.readFileSync("../imageworker/src/index.js", "utf8");
src = src.replace(/^import .*$/mg, "").replace(/^const FONTS.*$/m, "").replace("export default {", "const W = {") + "\nexport { expectedCounty, locate };";
fs.writeFileSync("geo_w.mjs", src);
const { expectedCounty, locate } = await import("./geo_w.mjs");
let mapboxCounty = "Rowan County", censusOn = true;
globalThis.fetch = async (u) => {
  u = String(u);
  if (u.includes("api.mapbox.com")) return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [-83.1, 38.2] }, properties: { full_address: "100 High St", context: { district: { name: mapboxCounty }, region: { region_code: "OH" } } } }] }));
  if (u.includes("geocoding.geo.census.gov")) return new Response(JSON.stringify({ result: { addressMatches: censusOn ? [{ coordinates: { x: -82.647, y: 38.503 }, matchedAddress: "100 HIGH ST, COAL GROVE, OH", geographies: { Counties: [{ NAME: "Lawrence County" }] }, addressComponents: { state: "OH" } }] : [] } }));
  return new Response("{}");
};
assert.deepEqual(expectedCounty("Coal Grove, Lawrence Co, OH"), { county: "lawrence", st: "OH" });
assert.deepEqual(expectedCounty("Windsor Twp, Lawrence Co, OH"), { county: "lawrence", st: "OH" });
let r = await locate("100 High Street, Coal Grove, OH", "pin", "Coal Grove, Lawrence Co, OH", "t");
assert.equal(r.pick.source, "Census");                       // Mapbox landed in the wrong county
mapboxCounty = "Lawrence County";
r = await locate("100 High Street, Coal Grove, OH", "pin", "Coal Grove, Lawrence Co, OH", "t");
assert.equal(r.pick.source, "Mapbox");                       // both fine: Mapbox first
mapboxCounty = "Rowan County"; censusOn = false;
r = await locate("100 High Street, Coal Grove, OH", "pin", "Coal Grove, Lawrence Co, OH", "t");
assert.equal(r.pick, null); assert.equal(r.fallback, true);  // nothing in the county: area view, no pin
fs.unlinkSync("geo_w.mjs");
console.log("geocode ok");
