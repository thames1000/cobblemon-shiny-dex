/* build-fishing-pool.js — the FULL fishing spawn pool, for the Poké Bait simulator.
 *
 * The Magikarp guide (build-karp-patterns.js) only keeps the uncommon-bucket
 * *pattern* weights. The Poké Bait tab needs every fishable species in every
 * bucket so it can rank "what will I catch here" the way the Poké Snack tab ranks
 * wild spawns — then apply a seasoned bait's effects on top.
 *
 * Point this at the COBBLEVERSE datapack's spawn pool (NOT the Cobblemon jar's —
 * the pack overrides the whole fishing pool):
 *   node scripts/build-fishing-pool.js \
 *     /home/user/TempCheck/COBBLEVERSE-DP-v29-Apex/data/cobblemon/spawn_pool_world
 *
 * Fishing mechanics are decompiled from Cobblemon-fabric-1.7.3+1.21.1
 * (PokeRodFishingBobberEntity.planSpawn / BucketNormalizingInfluence):
 *   - The bobber sums every attached bait's `rarity_bucket` value → a tier, adds
 *     Luck of the Sea, and applies ONE BucketNormalizingInfluence(tier, gradient
 *     0.2, firstTier 1.29) to the base bucket weights (NO BucketMultiplying, unlike
 *     the Poké Snack). Lure ENCHANT level is NOT part of the tier — it only speeds
 *     bites and gates `minLureLevel` spawns, and scales `minLureLevel`-conditioned
 *     weight multipliers.
 * So this file keeps, per spawn row: the biome-resolved base weight, the bucket,
 * the row's `minLureLevel` gate, and any Lure-conditioned weight multipliers, which
 * the app resolves at runtime once you pick a Lure level.
 */
const fs = require("fs");
const path = require("path");

const POOLDIR = process.argv[2] || "/home/user/TempCheck/COBBLEVERSE-DP-v29-Apex/data/cobblemon/spawn_pool_world";
const ROOT = path.join(__dirname, "..");
const BIOMES = path.join(ROOT, "js", "data", "biome-spawns.json");
const VARIANTS = path.join(ROOT, "js", "data", "variants.json");
const KARP = path.join(ROOT, "js", "data", "karp-patterns.json");
const OUT = process.argv[3] || path.join(ROOT, "js", "data", "fishing-pool.json");

// Verified against config/cobblemon/spawning/best-spawner-config.json in the pack.
const BUCKETS = { common: 88.5, uncommon: 10, rare: 1.2, "ultra-rare": 0.3 };
const NORMALIZE = { firstTier: 1.29, gradient: 0.2 };
const SHINY_RATE = 8192;

// The three sky scenarios that actually occur in the fishing pool's conditions
// (canSeeSky + minSkyLight/maxSkyLight bands): open sky (light 15), covered-but-lit
// (canSeeSky false, 8-15) and dark/underground (canSeeSky false, 0-7).
const SCEN = {
  surface: { sky: true, light: 15, label: "Open sky" },
  covered: { sky: false, light: 12, label: "Covered / shallow (sky light 8–15)" },
  deep: { sky: false, light: 3, label: "Underground / dark (sky light ≤ 7)" },
};

const readable = (id) => id.replace(/^minecraft:/, "").replace(/_/g, " ");
// "#cobblemon:is_spooky" -> "spooky" (matches the label vocabulary in biome-spawns.json)
const catLabel = (ref) => String(ref).replace(/^#?[a-z0-9_.-]+:/, "").replace(/^is_/, "").replace(/_/g, " ");
const dexOf = (file) => { const m = file.match(/^(\d+)/); return m ? Number(m[1]) : null; };
const aspectOf = (pokemon) => { const i = pokemon.indexOf("="); return i < 0 ? null : pokemon.slice(pokemon.lastIndexOf(" ", i) + 1); };

// A weight multiplier group: { x, cats?, lure?[min,max] }. Cobblemon splits cleanly —
// a multiplier is conditioned on biomes OR on lure level, never both (verified over
// the pack). Biome/no-condition ones fold into the base weight at build time; lure
// ones are kept for the app to resolve against the chosen Lure level.
function multipliers(s) {
  const raw = [];
  if (s.weightMultiplier) raw.push(s.weightMultiplier);
  if (Array.isArray(s.weightMultipliers)) raw.push(...s.weightMultipliers);
  return raw.map((w) => {
    const c = w.condition || {};
    const cats = (c.biomes || []).map(catLabel);
    const hasLure = c.minLureLevel !== undefined || c.maxLureLevel !== undefined;
    return { x: w.multiplier, cats, lure: hasLure ? [c.minLureLevel ?? 0, c.maxLureLevel ?? 99] : null };
  });
}

// Resolve a fishing spawn's `pokemon=aspect` into the app's variant id, so the
// Poké Bait tab can rank / search variant catches (Magikarp Jump patterns,
// Basculin stripes, Shellos/Gastrodon seas, Hisuian region-bias fish). Magikarp
// patterns come straight from karp-patterns.json (which already dealiases the
// blue-saucy↔saucy-blue naming); everything else matches the variant's own aspect
// tokens / name for that dex.
function makeVariantResolver() {
  let V, K;
  try { V = JSON.parse(fs.readFileSync(VARIANTS, "utf8")); } catch { V = null; }
  try { K = JSON.parse(fs.readFileSync(KARP, "utf8")); } catch { K = null; }
  const allV = V ? [...Object.values(V.regional || {}).flat(), ...(V.cosmetic || []), ...(V.unown || []), ...(V.cobblemon || []), ...(V.cobbleverse || [])] : [];
  const byDex = {};
  for (const v of allV) (byDex[v.dex] || (byDex[v.dex] = [])).push(v);
  const karpByAspect = {};
  if (K) for (const p of K.patterns || []) karpByAspect[p.aspect] = p.magikarp;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  return (dex, aspect) => {
    if (!aspect) return null;
    const eq = aspect.indexOf("=");
    const key = eq < 0 ? "" : aspect.slice(0, eq);
    const val = eq < 0 ? aspect : aspect.slice(eq + 1);
    if (key === "magikarp_jump") return karpByAspect[val] || null;
    const cands = [val, key + "-" + val, val + "-" + key];
    if (key === "striped") cands.push(val + "striped");
    else if (key === "sea") cands.push(val + "-sea");
    else if (key === "region_bias") cands.push(val === "hisui" ? "hisuian" : val);
    const cset = new Set(cands.map(norm));
    for (const v of byDex[dex] || []) {
      const toks = [v.name, ...(v.aspects || [])].map(norm);
      if (toks.some((t) => cset.has(t))) return v.id;
    }
    return null;
  };
}

function main() {
  const B = JSON.parse(fs.readFileSync(BIOMES, "utf8"));
  const variantOf = makeVariantResolver();
  const unresolved = new Set();
  const overworld = Object.keys(B)
    .filter((id) => id.startsWith("minecraft:") && B[id].includes("any overworld"))
    .sort();
  const labelsOf = (id) => new Set([...B[id], readable(id)]);
  const matchesBiome = (refs, id) => {
    if (!refs || !refs.length) return true;
    const have = labelsOf(id);
    return refs.some((r) => r === "#cobblemon:is_overworld" || have.has(catLabel(r)));
  };

  // ---- collect every fishing spawn (all buckets) ----
  const all = [];
  for (const f of fs.readdirSync(POOLDIR)) {
    if (!f.endsWith(".json")) continue;
    const dex = dexOf(f);
    for (const s of JSON.parse(fs.readFileSync(path.join(POOLDIR, f), "utf8")).spawns || []) {
      if (s.spawnablePositionType !== "fishing") continue;
      s.__dex = dex; all.push(s);
    }
  }
  // Location- / gear- / bait-gated spawns would inflate a generic "cast anywhere"
  // pool, so exclude them (same policy as the Magikarp guide) and count them.
  const isGated = (s) => { const c = s.condition || {}; return c.structures || c.bobber || c.rodType || c.bait; };
  const excluded = all.filter(isGated).length;
  const pool = all.filter((s) => !isGated(s) && s.__dex && BUCKETS[s.bucket]);

  const rowApplies = (s, sc) => {
    const c = s.condition || {};
    if (c.canSeeSky !== undefined && c.canSeeSky !== sc.sky) return false;
    if (c.minSkyLight !== undefined && (sc.light < c.minSkyLight || sc.light > c.maxSkyLight)) return false;
    return true;
  };
  // Base weight = spawn weight × every biome/no-condition multiplier that matches
  // this biome. Lure-conditioned multipliers are kept separate (runtime).
  const baseWeight = (s, id) =>
    multipliers(s).reduce((w, g) => {
      if (g.lure) return w;                                   // deferred to runtime
      if (!g.cats.length) return w * g.x;                     // unconditional
      return g.cats.some((c) => labelsOf(id).has(c)) ? w * g.x : w;
    }, s.weight);
  const lureMults = (s) => multipliers(s).filter((g) => g.lure).map((g) => [g.x, g.lure[0], g.lure[1]]);

  const pools = {};
  let rowCount = 0;
  for (const id of overworld) {
    const byScen = {};
    for (const [scName, sc] of Object.entries(SCEN)) {
      const rows = pool.filter((s) => rowApplies(s, sc) && matchesBiome((s.condition || {}).biomes, id));
      if (!rows.length) continue;
      const entries = rows.map((s) => {
        const e = { d: s.__dex, r: s.bucket, w: +baseWeight(s, id).toFixed(4) };
        const ml = (s.condition || {}).minLureLevel;
        if (ml) e.ml = ml;                                    // Lure gate (omit when 0)
        const lm = lureMults(s);
        if (lm.length) e.lm = lm;                             // [x, minLure, maxLure]
        const a = aspectOf(s.pokemon || "");
        if (a) {
          e.a = a;
          const vid = variantOf(s.__dex, a);
          if (vid) e.v = vid; else unresolved.add(s.__dex + " " + a);
        }
        return e;
      }).filter((e) => e.w > 0);
      if (entries.length) { byScen[scName] = entries; rowCount += entries.length; }
    }
    if (Object.keys(byScen).length) pools[readable(id)] = byScen;
  }

  const out = {
    _note:
      "Full COBBLEVERSE-DP-v29 fishing spawn pool for the Poké Bait tab. `pools[biome][scenario]` lists every " +
      "fishable spawn row: d=dex, r=bucket, w=biome-resolved base weight, ml=minLureLevel gate (omitted when 0), " +
      "lm=[x,minLure,maxLure] Lure-conditioned weight multipliers (applied at runtime for the chosen Lure), " +
      "a=aspect, v=resolved variant id (VARIANT_BY_ID — Magikarp Jump patterns, Basculin stripes, seas, Hisuian). " +
      "Scenarios are sky-light bands (surface/covered/deep). Base bucket weights are the server's " +
      "Rarity Overhaul (88.5/10/1.2/0.3). Fishing applies ONE BucketNormalizingInfluence(tier=Σ bait rarity_bucket " +
      "+ Luck of the Sea, gradient 0.2, firstTier 1.29) — NO BucketMultiplying (that's Poké Snack only). Spawns " +
      "gated on structure / bobber / rodType / a specific bait are excluded. Decompiled from " +
      "Cobblemon-fabric-1.7.3+1.21.1 PokeRodFishingBobberEntity.",
    position: "fishing",
    buckets: BUCKETS, normalize: NORMALIZE, shinyRate: SHINY_RATE,
    scenarios: Object.fromEntries(Object.entries(SCEN).map(([k, v]) => [k, v.label])),
    pools,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`${Object.keys(pools).length} biomes · ${rowCount} pool rows · ${excluded} excluded (structure/bobber/rod/bait-gated) -> ${OUT} (${kb} KB)`);
  if (unresolved.size) console.log(`  aspects with no variant match (left as base species): ${[...unresolved].join(", ")}`);
}
main();
