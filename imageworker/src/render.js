// Builds the incident map image: a 1080x760 map on top, a 320 px text band below.
// Shared by the Worker (src/index.js) and the local test (test/render-test.mjs).

export const WIDTH = 1080;
export const MAP_HEIGHT = 760;
export const HEIGHT = 1080;

// Accent colour by the post's call emoji (MAP-IMAGES.md).
export const ACCENTS = {
  "🔥": "e53935", // fire: red
  "🚗": "f5a623", // crash: amber
  "🚓": "2f80ed", // police: blue
  "🌊": "00a8a8", // water: teal
  "⚠️": "f2c94c", // anything else: yellow
};

export function accentFor(emoji) {
  const e = String(emoji || "").trim();
  return ACCENTS[e] || ACCENTS[e.replace(/️/g, "")] || ACCENTS["⚠️"];
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Rough width check so long lines shrink instead of running off the image.
function fitSize(text, base, min, maxWidth, avgEm) {
  let size = base;
  while (size > min && String(text).length * size * avgEm > maxWidth) size -= 4;
  return size;
}

// mapPngBase64: the map image as base64 (or null for a plain background).
export function buildSvg({ line1, line2, line3, accent, mapPngBase64, logoPngBase64 }) {
  const a = "#" + String(accent || ACCENTS["⚠️"]).replace(/^#/, "");
  const l1 = String(line1 || "").toUpperCase();
  const s1 = fitSize(l1, 104, 64, WIDTH - 120, 0.5);
  const s2 = fitSize(line2, 50, 34, WIDTH - 120, 0.55);
  const s3 = fitSize(line3, 42, 30, WIDTH - 120, 0.52);
  const bandTop = MAP_HEIGHT;
  // Line 2 is optional: without it, lines 1 and 3 close up. The text block is centred in the band.
  const has2 = String(line2 || "").trim() !== "";
  const blockH = s1 + (has2 ? 26 + s2 + 22 : 30) + s3;
  const y1 = bandTop + 12 + Math.max(20, Math.round((HEIGHT - bandTop - 12 - blockH) / 2)) + s1;
  const y2 = y1 + 26 + s2;
  const y3 = has2 ? y2 + 22 + s3 : y1 + 30 + s3;
  const textBlock = [
    `<text x="60" y="${y1}" font-family="Oswald" font-weight="700" font-size="${s1}" fill="#ffffff">${esc(l1)}</text>`,
    has2 ? `<text x="60" y="${y2}" font-family="Inter" font-weight="600" font-size="${s2}" fill="${a}">${esc(line2)}</text>` : "",
    `<text x="60" y="${y3}" font-family="Inter" font-weight="400" font-size="${s3}" fill="#c9ced6">${esc(line3)}</text>`,
  ].join("\n  ");
  const map = mapPngBase64
    ? `<image href="data:image/png;base64,${mapPngBase64}" x="0" y="0" width="${WIDTH}" height="${MAP_HEIGHT}" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect x="0" y="0" width="${WIDTH}" height="${MAP_HEIGHT}" fill="#2b2f36"/>`;
  const logo = logoPngBase64
    ? `<image href="data:image/png;base64,${logoPngBase64}" x="${WIDTH - 60 - 150}" y="${bandTop + 40}" width="150" height="150" preserveAspectRatio="xMidYMid meet"/>`
    : "";
  const textRight = logoPngBase64 ? WIDTH - 240 : WIDTH - 60;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#0f1114"/>
  ${map}
  <rect x="0" y="${bandTop}" width="${WIDTH}" height="${HEIGHT - bandTop}" fill="#0f1114"/>
  <rect x="0" y="${bandTop}" width="${WIDTH}" height="12" fill="${a}"/>
  ${textBlock}
  ${logo}
</svg>`;
}

// Mapbox Static Images URL for the incident (@2x: same framing, twice the pixels, sharper labels), following the 📍 privacy levels:
// pin = exact address / intersection / mile marker; block = residential block (a soft circle, no pin);
// road = road only or an interstate exit; mile = interstate mile marker (lat/lon from the road file);
// town = town map; county = county map.
export function mapboxStaticUrl({ lon, lat, mode, accent, token, zoom: zoomOverride, style = "mapbox/dark-v11" }) {
  // Default zoom per privacy level; &z= on the request overrides it (0-20).
  const zoom = Number.isFinite(zoomOverride) ? Math.max(0, Math.min(20, zoomOverride)) : ({ pin: 18, block: 16, road: 15.5, mile: 14.5, town: 13, county: 10 }[mode] ?? 14);
  const a = String(accent || ACCENTS["⚠️"]).replace(/^#/, "");
  let overlay = "";
  if (mode === "pin") {
    overlay = `pin-l+${a}(${lon.toFixed(5)},${lat.toFixed(5)})/`;
  } else if (mode === "block" || mode === "road" || mode === "mile") {
    // Soft circle (~120 m for a block, ~400 m for a road or exit, ~800 m for a mile marker, which is
    // only approximate) instead of a pin, so no house is marked.
    const r = mode === "block" ? 120 : mode === "mile" ? 800 : 400;
    const pts = [];
    for (let i = 0; i <= 32; i++) {
      const t = (i / 32) * 2 * Math.PI;
      const dLat = (r * Math.sin(t)) / 111320;
      const dLon = (r * Math.cos(t)) / (111320 * Math.cos((lat * Math.PI) / 180));
      pts.push([+(lon + dLon).toFixed(5), +(lat + dLat).toFixed(5)]);
    }
    const gj = { type: "Feature", properties: { fill: "#" + a, "fill-opacity": 0.3, stroke: "#" + a, "stroke-width": 4, "stroke-opacity": 0.9 }, geometry: { type: "Polygon", coordinates: [pts] } };
    overlay = `geojson(${encodeURIComponent(JSON.stringify(gj))})/`;
  }
  return `https://api.mapbox.com/styles/v1/${style}/static/${overlay}${lon.toFixed(5)},${lat.toFixed(5)},${zoom},0/${WIDTH}x${MAP_HEIGHT}@2x?access_token=${encodeURIComponent(token)}`;
}

export function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
