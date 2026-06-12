/* Biome map worker — runs Terralith's real worldgen via deepslate.
 *
 * Loads the vendored Terralith 2.5.8 + vanilla 1.21.1 worldgen bundles, builds
 * the multi-noise biome source for a seed, and samples biomes at the surface
 * (quart Y=32 / block 128). Heavy, so it lives in a worker. Biome Replacer rules
 * and the colour table are applied here so the main thread just blits pixels.
 */
import * as d from "https://esm.sh/deepslate@0.23.6";

const { WorldgenRegistries: WR, Identifier, NoiseParameters, DensityFunction, NoiseGeneratorSettings, RandomState, MultiNoiseBiomeSource } = d;
const SURFACE_QY = 32; // quart Y of the surface sample (block 128) — clears caves

let ready = null;       // promise resolving once bundles are registered
let BUNDLES = null;     // {settings, biomeSource, colors, remap}
let cache = { seed: null, biomeSource: null, sampler: null };

function url(p) { return new URL(p, self.location.href).href; }
async function loadJson(p) { const r = await fetch(url(p)); if (!r.ok) throw new Error(`fetch ${p}: ${r.status}`); return r.json(); }

async function init() {
  const [dfs, noises, settings, biomeSourceJson, colors, remap] = await Promise.all([
    loadJson("data/worldgen/density_functions.json"),
    loadJson("data/worldgen/noises.json"),
    loadJson("data/worldgen/noise_settings.json"),
    loadJson("data/worldgen/biome_source.json"),
    loadJson("data/worldgen/biome_colors.json"),
    loadJson("data/worldgen/biome_replacer.json"),
  ]);
  for (const [id, j] of Object.entries(noises)) WR.NOISE.register(Identifier.parse(id), NoiseParameters.fromJson(j));
  for (const [id, j] of Object.entries(dfs)) WR.DENSITY_FUNCTION.register(Identifier.parse(id), DensityFunction.fromJson(j));
  BUNDLES = {
    settings: NoiseGeneratorSettings.fromJson(settings),
    biomeSourceJson,
    colors,
    remap,
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
function buildForSeed(seed) {
  if (cache.seed === seed && cache.sampler) return;
  const rs = new RandomState(BUNDLES.settings, seedToLong(seed));
  cache = { seed, biomeSource: MultiNoiseBiomeSource.fromJson(BUNDLES.biomeSourceJson), sampler: rs.sampler };
}
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
// Apply the Biome Replacer remap, then resolve a colour (fallback grey).
const colorCache = {};
function colorFor(id) {
  if (colorCache[id]) return colorCache[id];
  const mapped = BUNDLES.remap[id] || id;
  const hex = BUNDLES.colors[mapped] || BUNDLES.colors[id] || "#3a4a5a";
  return (colorCache[id] = hexToRgb(hex));
}

async function render(msg) {
  await ensureReady();
  buildForSeed(msg.seed);
  const { cols, rows, cx, cz, bpp } = msg;
  const bs = cache.biomeSource, sampler = cache.sampler;
  const rgba = new Uint8ClampedArray(cols * rows * 4);
  const present = new Set();
  const halfW = (cols * bpp) / 2, halfH = (rows * bpp) / 2;
  for (let py = 0; py < rows; py++) {
    const bz = cz - halfH + (py + 0.5) * bpp;
    for (let px = 0; px < cols; px++) {
      const bx = cx - halfW + (px + 0.5) * bpp;
      const id = bs.getBiome(Math.floor(bx) >> 2, SURFACE_QY, Math.floor(bz) >> 2, sampler).toString();
      present.add(id);
      const [r, g, b] = colorFor(id);
      const o = (py * cols + px) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
    if ((py & 15) === 0) self.postMessage({ type: "progress", pct: Math.round((py / rows) * 100) });
  }
  // legend: present biomes after remap, with their colour
  const legend = [...present].map((id) => {
    const mapped = BUNDLES.remap[id] || id;
    return { id: mapped, hex: BUNDLES.colors[mapped] || BUNDLES.colors[id] || "#3a4a5a" };
  });
  const uniq = {}; for (const l of legend) uniq[l.id] = l.hex;
  self.postMessage({ type: "done", rgba: rgba.buffer, cols, rows, legend: Object.entries(uniq).map(([id, hex]) => ({ id, hex })) }, [rgba.buffer]);
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "render") render(msg).catch((err) => self.postMessage({ type: "error", message: String(err && err.message || err) }));
};
