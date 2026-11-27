// TLR Scribe map image Worker.
// GET /map.png?sig=<HMAC>&e=🔥&l1=STRUCTURE FIRE&l2=Working fire&l3=Ashland, Boyd Co, KY
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

// Expected county and state from image line 3 ("Coal Grove, Lawrence Co, OH" -> lawrence / OH), so a result
// can be checked: a pin outside the incident's county is wrong, whatever the geocoder says.
function expectedCounty(l3) {
  const m = String(l3 || "").match(/(?:^|,)\s*([^,]+?)\s+(?:Co|County|Parish|Borough)\.?\s*,\s*([A-Za-z]{2})\s*$/);
  return m ? { county: normCounty(m[1]), st: m[2].toUpperCase() } : null;
}
function normCounty(c) { return String(c || "").toLowerCase().replace(/\b(county|parish|borough|co)\b\.?/g, "").replace(/[^a-z]/g, ""); }
function inCounty(r, want) {
  if (!r || !want || !r.county) return null; // unknown
  return normCounty(r.county) === want.county && (!r.st || r.st === want.st);
}

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
  const ctx = (f.properties && f.properties.context) || {};
  return { source: "Mapbox", lon, lat, name: (f.properties && (f.properties.full_address || f.properties.name)) || "",
    county: (ctx.district && ctx.district.name) || "", st: (ctx.region && (ctx.region.region_code || "")).toUpperCase() };
}

// US Census Bureau geocoder: free, no key, street addresses only, and it reports the county the address is in.
async function censusGeocode(q) {
  const u = new URL("https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress");
  u.searchParams.set("address", q);
  u.searchParams.set("benchmark", "Public_AR_Current");
  u.searchParams.set("vintage", "Current_Current");
  u.searchParams.set("layers", "Counties");
  u.searchParams.set("format", "json");
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const m = (((await res.json()).result || {}).addressMatches || [])[0];
    if (!m || !m.coordinates) return null;
    const c = ((m.geographies || {}).Counties || [])[0] || {};
    return { source: "Census", lon: m.coordinates.x, lat: m.coordinates.y, name: m.matchedAddress || "",
      county: c.NAME || c.BASENAME || "", st: ((m.addressComponents || {}).state || "").toUpperCase() };
  } catch { return null; }
}

// Pick a location: ask Mapbox (and, for street addresses, the Census geocoder) and keep a result inside the
// expected county. Returns { pick, candidates, fallback } where fallback means "no trustworthy pin: show the
// town or county instead".
async function locate(q, mode, l3, token) {
  const want = expectedCounty(l3);
  const address = (mode === "pin" || mode === "block") && /^\s*\d/.test(q);
  const [mb, cs] = await Promise.all([geocode(q, mode, token).catch(() => null), address ? censusGeocode(q) : null]);
  const candidates = [mb, cs].filter(Boolean).map((c) => ({ ...c, inCounty: inCounty(c, want) }));
  const ok = candidates.filter((c) => c.inCounty === true);
  if (ok.length) return { pick: ok[0], candidates };
  if (!want) return { pick: candidates[0] || null, candidates };          // nothing to check against
  const unknown = candidates.filter((c) => c.inCounty === null);
  if (unknown.length && !candidates.some((c) => c.inCounty === false)) return { pick: unknown[0], candidates };
  return { pick: null, candidates, fallback: true };                       // every result is in the wrong county
}

// AUTH: sig = HMAC-SHA256(IMAGE_KEY, the other parameters sorted as k=v joined by &), first 40 hex characters,
// as the main Worker builds it, so the key itself never travels. The old ?key=IMAGE_KEY still works until
// IMAGE_REQUIRE_SIG=on is set (deploy the new main Worker first, then turn it on).
async function authorized(params, env) {
  const sig = params.get("sig");
  if (sig) {
    const canon = [...params.entries()].filter(([k]) => k !== "sig" && k !== "key").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(env.IMAGE_KEY).trim()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const want = [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(canon)))].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 40);
    return same(sig, want);
  }
  if (String(env.IMAGE_REQUIRE_SIG || "").toLowerCase() === "on") return false;
  return same(params.get("key") || "", String(env.IMAGE_KEY).trim());
}
function same(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return new Response("tlr-scribe-imageworker ok\n");
    if (url.pathname !== "/map.png" && url.pathname !== "/lookup") return new Response("not found\n", { status: 404 });
    if (!env.IMAGE_KEY || !(await authorized(url.searchParams, env))) return new Response("forbidden\n", { status: 403 });
    if (!env.MAPBOX_TOKEN) return new Response("MAPBOX_TOKEN not set\n", { status: 500 });

    // Lookup for the review page: every source's answer for an address, marked in or out of the county.
    if (url.pathname === "/lookup") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return Response.json({ error: "need q" }, { status: 400 });
      const want = expectedCounty(url.searchParams.get("l3"));
      const [a, b, c] = await Promise.all([geocode(q, "pin", env.MAPBOX_TOKEN).catch(() => null), geocode(q, "town", env.MAPBOX_TOKEN).catch(() => null), censusGeocode(q)]);
      const seen = new Set();
      const candidates = [a, c, b].filter(Boolean).filter((x) => { const k = x.lat.toFixed(4) + x.lon.toFixed(4); if (seen.has(k)) return false; seen.add(k); return true; })
        .map((x) => ({ ...x, inCounty: inCounty(x, want) }));
      return Response.json({ candidates, county: want });
    }

    // Cache by the request without the key or signature.
    const cacheUrl = new URL(url);
    cacheUrl.searchParams.delete("key");
    cacheUrl.searchParams.delete("sig");
    const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const p = url.searchParams;
    let mode = MODES.has(p.get("mode")) ? p.get("mode") : "town";
    const accent = /^[0-9a-fA-F]{6}$/.test(p.get("c") || "") ? p.get("c") : accentFor(p.get("e"));
    let lon = parseFloat(p.get("lon")), lat = parseFloat(p.get("lat"));
    let found = "";
    try {
      if (!(isFinite(lon) && isFinite(lat))) {
        const q = (p.get("q") || p.get("l3") || "").trim();
        if (!q) return new Response("need q or lat/lon\n", { status: 400 });
        let { pick, fallback } = await locate(q, mode, p.get("l3"), env.MAPBOX_TOKEN);
        if (!pick && fallback) {
          // No result in the right county: show the town or county from line 3, without a pin.
          const area = String(p.get("l3") || "").replace(/\bCo\b\.?/, "County");
          pick = await geocode(area, "town", env.MAPBOX_TOKEN).catch(() => null) || await geocode(area, "county", env.MAPBOX_TOKEN).catch(() => null);
          if (pick) { mode = "town"; pick = { ...pick, source: pick.source + " (area only: no match in the county)" }; }
        }
        if (!pick) return new Response("location not found\n", { status: 404 });
        ({ lon, lat } = pick);
        found = `${pick.name} [${pick.source}]`;
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
