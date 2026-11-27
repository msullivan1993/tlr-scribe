// Local render test with no network: placeholder map, real fonts. Writes test/out-*.png
import fs from "fs";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { buildSvg, accentFor, mapboxStaticUrl } from "../src/render.js";
const dir = new URL("..", import.meta.url).pathname;
await initWasm(fs.readFileSync(dir + "node_modules/@resvg/resvg-wasm/index_bg.wasm"));
const fonts = ["Oswald_700Bold.ttf", "Inter_600SemiBold.ttf", "Inter_400Regular.ttf"].map((f) => fs.readFileSync(dir + "fonts/" + f));
const cases = [
  { e: "🔥", l1: "Structure Fire", l2: "Working fire", l3: "Ashland, Boyd Co, KY" },
  { e: "🚗", l1: "Vehicle Crash", l2: "Two vehicles, injuries reported", l3: "Rush Township, Scioto Co, OH" },
  { e: "⚠️", l1: "Gas Leak", l2: "Building evacuated", l3: "Lucasville, Scioto Co, OH" },
  { e: "🔥", l1: "Possible Structure Fire", l2: "", l3: "Portsmouth, Scioto Co, OH" },
];
for (const [i, c] of cases.entries()) {
  const svg = buildSvg({ line1: c.l1, line2: c.l2, line3: c.l3, accent: accentFor(c.e), mapPngBase64: null });
  const png = new Resvg(svg, { font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: "Inter" } }).render().asPng();
  fs.writeFileSync(dir + `test/out-${i}.png`, png);
}
console.log(mapboxStaticUrl({ lon: -82.64, lat: 38.48, mode: "block", accent: accentFor("🚗"), token: "pk.TEST" }).slice(0, 160));
console.log("ok");
