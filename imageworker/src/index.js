// TLR Scribe map image Worker.
// GET /map.png?key=IMAGE_KEY&e=🔥&l1=STRUCTURE FIRE&l2=Working fire&l3=Ashland, Boyd Co, KY
//              &q=1200 Winchester Avenue, Ashland, KY&mode=pin|block|road|mile|town|county
//              (or &lat=..&lon=.. instead of q); optional &z=17 to set the zoom
// Returns a 1080x1080 PNG: dark Mapbox map with the incident marked per the 📍 privacy level,
// and a three-line text band in the incident's accent colour. Results are cached for 7 days.
//
// Secrets: MAPBOX_TOKEN (pk.… token), IMAGE_KEY (any long random string; callers must send it).
// Deployed from GitHub (Cloudflare Workers Builds, root directory "imageworker").

import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import oswaldBold from "../fonts/Oswald_700Bold.ttf";
import interSemi from "../fonts/Inter_600SemiBold.ttf";
import interReg from "../fonts/Inter_400Regular.ttf";
import { buildSvg, mapboxStaticUrl, accentFor, toBase64 } from "./render.js";

let wasmReady = null;
const FONTS = [new Uint8Array(oswaldBold), new Uint8Array(interSemi), new Uint8Array(interReg)];

const MODES = new Set(["pin", "block", "road", "mile", "town", "county"]);
const GEO_TYPES = { pin: "address,street", block: "address,street", road: "street", mile: "street", town: "place,locality,neighborhood", county: "district" };

async function geocode(q, mode, token) {
  const u = new URL("https://api.mapbox.com/search/geocode/v6/forward");
  u.searchParams.set("q", q);
  u.searchParams.set("country", "us");
  u.searchParams.set("limit", "1");
  if (GEO_TYPES[mode]) u.searchParams.set("types", GEO_TYPES[mode]);
  u.searchParams.set("access_token", token);
  const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`geocode ${res.status}`);
  const data = await res.json();
  const f = data.features && data.features[0];
  if (!f || !f.geometry) return null;
  const [lon, lat] = f.geometry.coordinates;
  return { lon, lat, name: (f.properties && (f.properties.full_address || f.properties.name)) || "" };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return new Response("tlr-scribe-imageworker ok\n");
    if (url.pathname !== "/map.png") return new Response("not found\n", { status: 404 });
    if (!env.IMAGE_KEY || url.searchParams.get("key") !== env.IMAGE_KEY) return new Response("forbidden\n", { status: 403 });
    if (!env.MAPBOX_TOKEN) return new Response("MAPBOX_TOKEN not set\n", { status: 500 });

    // Cache by the request without the key.
    const cacheUrl = new URL(url);
    cacheUrl.searchParams.delete("key");
    const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const p = url.searchParams;
    const mode = MODES.has(p.get("mode")) ? p.get("mode") : "town";
    const accent = p.get("c") || accentFor(p.get("e"));
    let lon = parseFloat(p.get("lon")), lat = parseFloat(p.get("lat"));
    let found = "";
    try {
      if (!(isFinite(lon) && isFinite(lat))) {
        const q = (p.get("q") || p.get("l3") || "").trim();
        if (!q) return new Response("need q or lat/lon\n", { status: 400 });
        const g = await geocode(q, mode, env.MAPBOX_TOKEN);
        if (!g) return new Response("location not found\n", { status: 404 });
        ({ lon, lat } = g);
        found = g.name;
      }
      const mapRes = await fetch(mapboxStaticUrl({ lon, lat, mode, accent, token: env.MAPBOX_TOKEN, zoom: p.has("z") ? parseFloat(p.get("z")) : undefined }), { signal: AbortSignal.timeout(20000) });
      if (!mapRes.ok) return new Response(`map ${mapRes.status}\n`, { status: 502 });
      const mapB64 = toBase64(await mapRes.arrayBuffer());
      const svg = buildSvg({ line1: p.get("l1"), line2: p.get("l2"), line3: p.get("l3"), accent, mapPngBase64: mapB64 });
      if (!wasmReady) wasmReady = initWasm(resvgWasm);
      await wasmReady;
      const png = new Resvg(svg, {
        font: { fontBuffers: FONTS, loadSystemFonts: false, defaultFontFamily: "Inter" },
        // Facebook keeps a 2048px image sharper than a 1080px one (it re-compresses smaller uploads harder).
        // The layout stays 1080 units; resvg scales the vector text and shapes up. OUTPUT_WIDTH=1080 turns it off.
        fitTo: { mode: "width", value: Number(env.OUTPUT_WIDTH || 2048) },
      }).render().asPng();
      const res = new Response(png, {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800", "X-Geocoded": encodeURIComponent(found) },
      });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    } catch (e) {
      return new Response(`error: ${String(e && e.message ? e.message : e)}\n`, { status: 500 });
    }
  },
};
