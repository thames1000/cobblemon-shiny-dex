/* Biome map worker — runs Terralith's real worldgen via deepslate.
 *
 * Loads the vendored Terralith 2.5.8 + vanilla 1.21.1 worldgen bundles, builds
 * the multi-noise biome source for a seed, and samples biomes at the surface
 * (quart Y=32 / block 128). Heavy, so it lives in a worker. Biome Replacer rules
 * and the colour table are applied here so the main thread just blits pixels.
 *
 * deepslate is loaded by DYNAMIC import (not a top-level import) so a CDN failure
 * surfaces a real error message instead of an opaque worker onerror, and so we can
 * fall back across CDNs. jsDelivr's +esm is a single self-contained bundle (robust
 * in a worker); esm.sh splits into nested imports that can fail, so it's the backup.
 */
const SURFACE_QY = 32; // quart Y of the surface sample (block 128) — clears caves
const CDNS = [
  "https://cdn.jsdelivr.net/npm/deepslate@0.23.6/+esm",
  "https://esm.sh/deepslate@0.23.6",
];

let D = null;           // deepslate module
let C = null;           // { WR, Identifier, NoiseParameters, DensityFunction, NoiseGeneratorSettings, RandomState, MultiNoiseBiomeSource }
let ready = null;       // promise resolving once engine + bundles are loaded
let BUNDLES = null;     // { settings, biomeSourceJson, colors, remap }
let cache = { seed: null, biomeSource: null, sampler: null };

function url(p) { return new URL(p, self.location.href).href; }
async function loadJson(p) { const r = await fetch(url(p)); if (!r.ok) throw new Error(`fetch ${p}: HTTP ${r.status}`); return r.json(); }

async function loadEngine() {
  let lastErr;
  for (const u of CDNS) {
    try { return await import(u); }
    catch (e) { lastErr = e; }
  }
  throw new Error("couldn't load the worldgen engine (deepslate) — check your connection / ad-blocker." + (lastErr ? " [" + (lastErr.message || lastErr) + "]" : ""));
}

async function init() {
  D = await loadEngine();
  C = {
    WR: D.WorldgenRegistries, Identifier: D.Identifier, NoiseParameters: D.NoiseParameters,
    DensityFunction: D.DensityFunction, NoiseGeneratorSettings: D.NoiseGeneratorSettings,
    RandomState: D.RandomState, MultiNoiseBiomeSource: D.MultiNoiseBiomeSource,
  };
  const [dfs, noises, sOW, sNether, bsOW, bsNether, colors, remap] = await Promise.all([
    loadJson("data/worldgen/density_functions.json"),
    loadJson("data/worldgen/noises.json"),
    loadJson("data/worldgen/noise_settings.json"),
    loadJson("data/worldgen/noise_settings_nether.json"),
    loadJson("data/worldgen/biome_source.json"),
    loadJson("data/worldgen/biome_source_nether.json"),
    loadJson("data/worldgen/biome_colors.json"),
    loadJson("data/worldgen/biome_replacer.json"),
  ]);
  for (const [id, j] of Object.entries(noises)) C.WR.NOISE.register(C.Identifier.parse(id), C.NoiseParameters.fromJson(j));
  for (const [id, j] of Object.entries(dfs)) C.WR.DENSITY_FUNCTION.register(C.Identifier.parse(id), C.DensityFunction.fromJson(j));
  BUNDLES = {
    settings: { overworld: C.NoiseGeneratorSettings.fromJson(sOW), nether: C.NoiseGeneratorSettings.fromJson(sNether) },
    biomeSourceJson: { overworld: bsOW, nether: bsNether },
    colors, remap,
  };
}
function ensureReady() { if (!ready) ready = init(); return ready; }

// World seed: numeric string taken literally, else Java String.hashCode (like MC).
function seedToLong(s) {
  s = String(s == null ? "" : s).trim();
  if (s === "") return 0n;
  if (/^-?\d+$/.test(s)) return BigInt.asIntN(64, BigInt(s));
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return BigInt(h);
}
function buildForSeed(seed, dim) {
  if (cache.seed === seed && cache.dim === dim && cache.sampler) return;
  const rs = new C.RandomState(BUNDLES.settings[dim], seedToLong(seed));
  // A terrain-density fn lets us find the real surface so biomes match the server
  // (elevation biomes like blooming_plateau/arid_highlands are wrong at a fixed Y).
  // initialDensityWithoutJaggedness is cheaper than finalDensity and within a few
  // blocks for height — plenty for picking the biome Y. Overworld only; defensive.
  let heightFn = null;
  try { heightFn = rs.router && (rs.router.initialDensityWithoutJaggedness || rs.router.finalDensity); } catch (e) { heightFn = null; }
  cache = { seed, dim, biomeSource: C.MultiNoiseBiomeSource.fromJson(BUNDLES.biomeSourceJson[dim]), sampler: rs.sampler, heightFn };
}
// Highest solid quart-Y at (bx,bz) ≈ getBaseHeight(WORLD_SURFACE_WG): scan top-down
// coarsely, then refine to ~8 blocks. Returns quart Y (block>>2).
const H_TOP = 256, H_BOTTOM = -60, H_COARSE = 32, H_FINE = 8, SEA_QY = 63 >> 2;
function surfaceQuartY(fd, bx, bz) {
  const ctx = { x: bx, y: 0, z: bz };
  let found = null;
  for (let y = H_TOP; y >= H_BOTTOM; y -= H_COARSE) {
    ctx.y = y;
    if (fd.compute(ctx) > 0) { found = y; break; }
  }
  if (found === null) return SEA_QY; // open column → sea level
  for (let yy = found + H_COARSE - H_FINE; yy > found; yy -= H_FINE) {
    ctx.y = yy;
    if (fd.compute(ctx) > 0) return yy >> 2;
  }
  return found >> 2;
}
// Cave mode: cave biomes live underground at various depths, so scan a few quart-Ys
// and return the first cave biome found (else the deepest sampled regional biome).
const CAVE_QYS = [12, 4, -4, -12, -16]; // blocks ~48, 16, -16, -48, -64
const CAVE_RE = /cave|deep_dark/;
function caveBiomeAt(bs, sampler, qx, qz) {
  let last = "minecraft:plains";
  for (let i = 0; i < CAVE_QYS.length; i++) {
    last = bs.getBiome(qx, CAVE_QYS[i], qz, sampler).toString();
    if (CAVE_RE.test(last)) return last;
  }
  return last;
}
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
const colorCache = {};
function colorFor(id) {
  if (colorCache[id]) return colorCache[id];
  const mapped = BUNDLES.remap[id] || id;
  const hex = BUNDLES.colors[mapped] || BUNDLES.colors[id] || "#3a4a5a";
  return (colorCache[id] = hexToRgb(hex));
}

async function render(msg) {
  await ensureReady();
  buildForSeed(msg.seed, msg.dim || "overworld");
  const { cols, rows, cx, cz, bpp } = msg;
  const bs = cache.biomeSource, sampler = cache.sampler;
  const caves = !!msg.caves && cache.dim === "overworld"; // cave-layer view
  // Sample at the real surface height for the overworld; nether/end keep the fixed Y.
  const fd = (!caves && cache.dim === "overworld") ? cache.heightFn : null;
  // Surface height is smooth, so compute it on a coarse grid and reuse — sized so the
  // total height-scans stay ~constant regardless of zoom (keeps renders fast).
  const HBUDGET = 2600, viewW = cols * bpp;
  const hStep = Math.max(8, Math.ceil(viewW / Math.sqrt(HBUDGET) / 4) * 4); // multiple of 4
  const hCache = new Map();
  const rgba = new Uint8ClampedArray(cols * rows * 4);
  const ids = new Uint16Array(cols * rows); // palette index per cell, for hover lookups
  const palette = [], pIdx = {};            // original (pre-remap) biome ids
  const halfW = (cols * bpp) / 2, halfH = (rows * bpp) / 2;
  for (let py = 0; py < rows; py++) {
    const bz = cz - halfH + (py + 0.5) * bpp;
    for (let px = 0; px < cols; px++) {
      const bx = cx - halfW + (px + 0.5) * bpp;
      const qx = Math.floor(bx) >> 2, qz = Math.floor(bz) >> 2;
      let id;
      if (caves) {
        id = caveBiomeAt(bs, sampler, qx, qz);
      } else {
        let qy = SURFACE_QY;
        if (fd) {
          const gx = Math.floor(bx / hStep), gz = Math.floor(bz / hStep);
          const key = gx + "," + gz;
          let h = hCache.get(key);
          if (h === undefined) { h = surfaceQuartY(fd, gx * hStep + (hStep >> 1), gz * hStep + (hStep >> 1)); hCache.set(key, h); }
          qy = h;
        }
        id = bs.getBiome(qx, qy, qz, sampler).toString();
      }
      let pi = pIdx[id]; if (pi === undefined) { pi = palette.length; pIdx[id] = pi; palette.push(id); }
      ids[py * cols + px] = pi;
      const [r, g, b] = colorFor(id);
      const o = (py * cols + px) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
    if ((py & 15) === 0) self.postMessage({ type: "progress", pct: Math.round((py / rows) * 100) });
  }
  const uniq = {};
  for (const id of palette) { const mapped = BUNDLES.remap[id] || id; uniq[mapped] = BUNDLES.colors[mapped] || BUNDLES.colors[id] || "#3a4a5a"; }
  self.postMessage({ type: "done", rgba: rgba.buffer, ids: ids.buffer, palette, cols, rows, legend: Object.entries(uniq).map(([id, hex]) => ({ id, hex })) }, [rgba.buffer, ids.buffer]);
}

// Sample the biome at a list of world points (for validating seed-map candidates).
// Surface points use the real surface height; cave[i] points use the cave layer.
async function samplePoints(msg) {
  await ensureReady();
  buildForSeed(msg.seed, msg.dim || "overworld");
  const bs = cache.biomeSource, sampler = cache.sampler;
  const fd = (cache.dim === "overworld") ? cache.heightFn : null;
  const pts = msg.pts, cave = msg.cave || [], out = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const x = pts[i][0], z = pts[i][1], qx = Math.floor(x) >> 2, qz = Math.floor(z) >> 2;
    if (cave[i]) { out[i] = caveBiomeAt(bs, sampler, qx, qz); continue; }
    let qy = SURFACE_QY;
    if (fd) qy = surfaceQuartY(fd, Math.floor(x), Math.floor(z));
    out[i] = bs.getBiome(qx, qy, qz, sampler).toString();
  }
  self.postMessage({ type: "points", id: msg.id, biomes: out });
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "render") render(msg).catch((err) => self.postMessage({ type: "error", message: String(err && err.message || err) }));
  else if (msg.type === "samplePoints") samplePoints(msg).catch((err) => self.postMessage({ type: "points", id: msg.id, error: String(err && err.message || err) }));
};
