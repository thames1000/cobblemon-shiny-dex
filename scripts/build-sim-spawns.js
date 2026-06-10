/**
 * Build js/data/sim-spawns.json — structured spawn conditions for the Spawn
 * Simulator tab, generated from the Cobbleverse v29 extract.
 *
 * Unlike the compact spawns.json (which stores conditions as display strings in
 * `bo`), the simulator needs them machine-checkable: Y range, required nearby
 * blocks (placeable items like water / PC), required base block (the block the
 * mon spawns on), light window, sky, time, weather. Biome labels reuse the same
 * scheme as spawns.json and are filtered to biomes that exist in this pack
 * (intersected with spawns.json's biome universe — no tag dir needed).
 *
 * Output: { spawns: { dex: [entry,...] }, items: [{key,label,group}], baseBlocks: [{key,label}] }
 *   node scripts/build-sim-spawns.js
 */
const fs = require("fs");
const path = require("path");

const RESEARCH = path.join(__dirname, "..", "research", "cobbleverse-spawns-v29.json");
const SPAWNS = path.join(__dirname, "..", "js", "data", "spawns.json");
const HITBOX = path.join(__dirname, "..", "research", "cobblemon-hitboxes.json");
const OUT = path.join(__dirname, "..", "js", "data", "sim-spawns.json");

// ---- biome label (same string logic as build-spawns-datapack.js) ----
const readable = (s) => String(s).replace(/_/g, " ").trim();
const norm = (r) => (/^is_/.test(r) || /^nether\/is_/.test(r)) ? "#cobblemon:" + r : r;
function biomeLabel(rawRef) {
  const ref = norm(rawRef);
  if (/not_spawn|^not spawn$/.test(ref)) return null;
  const tag = ref.match(/^#?([a-z0-9_.-]+):(.+)$/);
  if (!tag) return readable(ref);
  const ns = tag[1], body = tag[2];
  if (ref[0] !== "#") return ns === "minecraft" ? readable(body) : null;
  if (body === "is_overworld") return "any overworld";
  if (body === "has_block/mud") return "mangrove swamp";
  const neth = body.match(/^nether\/is_(.+)$/);
  if (neth) return "nether " + readable(neth[1]);
  return readable(body.replace(/^is_/, ""));
}

// ---- block key -> readable label + picker group ----
const LABEL_OVERRIDE = { "cobblemon:pc": "PC", "cobblemon:monitor": "Monitor",
  "cobblemon:healing_machine": "Healing Machine", "cobblemon:restoration_tank": "Restoration Tank",
  "cobblemon:fossil_analyzer": "Fossil Analyzer", "minecraft:water": "Water", "minecraft:lava": "Lava" };
function blockLabel(key) {
  if (LABEL_OVERRIDE[key]) return LABEL_OVERRIDE[key];
  const tag = key.startsWith("#");
  const body = key.replace(/^#/, "").replace(/^[a-z0-9_.-]+:/, "");
  const name = body.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return tag ? name + " (any)" : name;
}
function blockGroup(key) {
  const b = key.replace(/^#/, "").replace(/^[a-z0-9_.-]+:/, "");
  if (/water|flowing_water|lily_pad|kelp|seagrass|coral/.test(b)) return "Fluids & Aquatic";
  if (/lava|magma/.test(b)) return "Lava & Heat";
  if (/flower|sunflower|sugar_cane|saccharine|berries|medicinal_leek|apricorn/.test(b)) return "Flowers & Plants";
  if (/ore|gemstone|amethyst|iron_block/.test(b)) return "Ores & Gems";
  if (/lightning_rod|repeater|redstone|comparator|daylight_detector/.test(b)) return "Redstone";
  if (/^(pc|monitor|healing_machine|restoration_tank|fossil_analyzer)$/.test(b)) return "Cobblemon machines";
  if (/wool|carpet|concrete|cake|bed|bell|pumpkin|cobweb|present|holiday/.test(b)) return "Decoration";
  return "Other";
}

function lvl(s) { return String(s.level || ""); }

function main() {
  const research = JSON.parse(fs.readFileSync(RESEARCH, "utf8")).species;
  const spawns = JSON.parse(fs.readFileSync(SPAWNS, "utf8"));

  // biomes that exist in this pack (the dropdown universe) — drop foreign ones.
  const okBiomes = new Set();
  for (const d in spawns) for (const e of spawns[d]) for (const b of e.b || []) okBiomes.add(b);

  const out = {};
  const itemKeys = new Set(), baseKeys = new Set();

  for (const k of Object.keys(research)) {
    const sp = research[k];
    const dex = sp.dex != null ? String(sp.dex) : k;
    const entries = [];
    for (const s of sp.spawns || []) {
      if (!s.weight) continue; // weight 0 = summon/structure-only, can't be block-spawned
      const biomes = [...new Set((s.biomes.include || []).map(biomeLabel).filter((b) => b && okBiomes.has(b)))];
      if (!biomes.length) continue;
      const e = { b: biomes, r: s.rarity, w: s.weight, lv: lvl(s) };
      if (s.position && s.position !== "grounded") e.pos = s.position;
      if (s.y && (s.y.min != null || s.y.max != null)) e.y = [s.y.min != null ? s.y.min : null, s.y.max != null ? s.y.max : null];
      if (s.nearbyBlocks && s.nearbyBlocks.length) { e.near = s.nearbyBlocks; s.nearbyBlocks.forEach((x) => itemKeys.add(x)); }
      if (s.baseBlocks && s.baseBlocks.length) { e.base = s.baseBlocks; s.baseBlocks.forEach((x) => baseKeys.add(x)); }
      if (s.time) e.t = s.time;
      if (s.weather && s.weather.length) e.wx = s.weather;
      if (s.sky && s.sky.canSeeSky === true) e.sky = true;
      else if (s.sky && s.sky.canSeeSky === false) e.sky = false;
      if (s.sky && (s.sky.minSkyLight != null || s.sky.maxSkyLight != null)) e.lt = [s.sky.minSkyLight != null ? s.sky.minSkyLight : 0, s.sky.maxSkyLight != null ? s.sky.maxSkyLight : 15];
      if (s.sky && s.sky.maxLight != null) e.ml = s.sky.maxLight;
      if (s.moonPhase != null) e.moon = String(s.moonPhase);
      entries.push(e);
    }
    // dedup identical entries (extract has rod-tier / form duplicates)
    const seen = new Set(), uniq = [];
    for (const e of entries) { const key = JSON.stringify(e); if (!seen.has(key)) { seen.add(key); uniq.push(e); } }
    if (uniq.length) out[dex] = uniq;
  }

  const items = [...itemKeys].map((key) => ({ key, label: blockLabel(key), group: blockGroup(key) }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
  const baseBlocks = [...baseKeys].map((key) => ({ key, label: blockLabel(key) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // Per-dex hitbox [width, height] — a spawn needs vertical clearance >= its
  // hitbox height, so the simulator gates on the chosen spawn-area height.
  const hb = JSON.parse(fs.readFileSync(HITBOX, "utf8")).byDex;
  const hitbox = {};
  for (const dex of Object.keys(out)) if (hb[dex]) hitbox[dex] = [hb[dex].w, hb[dex].h];

  fs.writeFileSync(OUT, JSON.stringify({ spawns: out, items, baseBlocks, hitbox }));
  const nEntries = Object.values(out).reduce((a, x) => a + x.length, 0);
  console.log("Wrote", OUT);
  console.log("  species:", Object.keys(out).length, "| entries:", nEntries, "| items:", items.length, "| base blocks:", baseBlocks.length, "| hitboxes:", Object.keys(hitbox).length);
}
main();
