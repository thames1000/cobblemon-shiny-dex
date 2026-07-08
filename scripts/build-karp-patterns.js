/* build-karp-patterns.js
 *
 * Regenerate js/data/karp-patterns.json — the data behind the Spawns tab's
 * "Magikarp & Gyarados fishing guide" and its variant lookup.
 *
 * Why this needs its own file: scripts/build-spawns-datapack.js lists
 * `magikarp_jump` in its COSMETIC map, which deliberately collapses the aspect
 * away so identical rows merge. That is right for the normal Spawns view (all 41
 * rows would read "uncommon · fishing · any overworld") but it throws away the
 * only thing that distinguishes the 31 patterns: their per-biome
 * `weightMultiplier(s)`.
 *
 * Everything below is read from the pack, not the wiki:
 *
 *  - Every pattern is a `fishing` spawn in the `uncommon` bucket with
 *    `minLureLevel: 1`. Cobblemon takes that from the rod's LURE enchantment
 *    (PokerodItem -> Enchantments.LURE = yarn field_9100), so a Poké Rod with
 *    Lure I+ is mandatory. Patterns never come from submerged/surface spawns.
 *  - Patterns spawn in `#cobblemon:is_overworld` (anywhere) but each is 3x/5x
 *    likelier in specific biome categories — the whole "where to fish" story.
 *  - `skyLight 0-7` rows are the wiki's "Underground" multiplier. Sky light in
 *    Minecraft is time-independent, so this is depth/cover, NOT night.
 *  - Gyarados has no patterned spawns: it inherits magikarp_jump when a patterned
 *    Magikarp evolves. Its dex entry only lists Normal + Mega.
 *
 * Bucket odds (Cobblemon 1.7.3, decompiled):
 *   PokeRodFishingBobberEntity.planSpawn() builds
 *     BucketNormalizingInfluence(tier = Σ(bait rarity_bucket) + luckOfTheSeaLevel)
 *   whose affectBucketWeights() does, for tier != 0:
 *     d = firstTier + gradient * (tier - 1)     // defaults 1.29, 0.2
 *     weight_i = weight_i ^ (1 / d)
 *   then the spawner normalises. Base weights come from
 *   `config/cobblemon/spawning/best-spawner-config.json`; COBBLEVERSE ships
 *   88.5/10/1.2/0.3, so an unbuffed cast is a 10% shot at the uncommon bucket.
 *   (Base Cobblemon is 94.3/5/0.5/0.2 -> 5%, which is exactly the "flat 5%" the
 *   Cobblemon wiki quotes. The wiki's "+2.5% per Luck level" is a linear
 *   approximation; the real curve is the exponent above.)
 *
 * Shiny (FishingSpawnCause.Companion.shinyReroll, decompiled):
 *   if (!pokemon.shiny) { roll = Random.nextInt(0, shinyRate + 1)
 *                         if (roll <= effect.value) pokemon.shiny = true }
 *   i.e. a `shiny_reroll` bait adds (value + 1) / (shinyRate + 1) on top of the
 *   normal roll. Starf Berry is the ONLY berry with shiny_reroll (value 4).
 *
 * NOT modelled (documented in the output `_note`): `typing` and `egg_group` baits
 * reweight spawns *within* the bucket via SpawnBaitInfluence.affectWeight().
 * Starf Berry / the apples carry neither, so the numbers here are exact for them.
 *
 * The COBBLEVERSE datapack overrides 0129_magikarp.json AND the whole spawn pool,
 * so point this at the datapack copy, not the Cobblemon jar's:
 *   unzip -oq COBBLEVERSE-DP-v29.zip 'data/cobblemon/spawn_pool_world/*' -d /tmp/dp
 *   node scripts/build-karp-patterns.js /tmp/dp/data/cobblemon/spawn_pool_world
 */
const fs = require("fs");
const path = require("path");

const POOLDIR = process.argv[2] || "/tmp/dp/data/cobblemon/spawn_pool_world";
const ROOT = path.join(__dirname, "..");
const VARIANTS = path.join(ROOT, "js", "data", "variants.json");
const BIOMES = path.join(ROOT, "js", "data", "biome-spawns.json");
const OUT = process.argv[3] || path.join(ROOT, "js", "data", "karp-patterns.json");

// Verified against config/cobblemon/spawning/best-spawner-config.json in the pack.
const BUCKETS = { common: 88.5, uncommon: 10, rare: 1.2, "ultra-rare": 0.3 };
const NORMALIZE = { firstTier: 1.29, gradient: 0.2 };
const SHINY_RATE = 8192;

// item -> { shiny: shiny_reroll value, rarity: rarity_bucket value }
// Straight from data/cobblemon/spawn_bait_effects/. Only these three have shiny_reroll.
const BAITS = [
  { id: "none", label: "No bait", shiny: null, rarity: 0 },
  { id: "cobblemon:starf_berry", label: "Starf Berry", shiny: 4, rarity: 0, berry: true },
  { id: "minecraft:golden_apple", label: "Golden Apple", shiny: 1, rarity: 1 },
  { id: "minecraft:enchanted_golden_apple", label: "Enchanted Golden Apple", shiny: 9, rarity: 10 },
];

// The wiki renders two aspects in the opposite word order ("blue-saucy" -> "Saucy Blue"),
// so variant ids can't be derived from the aspect by string-munging alone.
const ID_ALIAS = { "blue-saucy": "saucy-blue", "violet-saucy": "saucy-violet" };
const variantId = (base, aspect) => `cob-${base}-${ID_ALIAS[aspect] || aspect}`;

// "#cobblemon:is_spooky" -> "spooky", matching the label vocabulary the rest of the
// Spawns tab uses (see build-spawns-datapack.js biomeLabel()).
const catLabel = (ref) => String(ref).replace(/^#?[a-z0-9_.-]+:/, "").replace(/^is_/, "").replace(/_/g, " ");
const readable = (id) => id.replace(/^minecraft:/, "").replace(/_/g, " ");

// Multiplier groups on a spawn: [{ x, cats:[…] }]. Each group whose condition matches
// the biome multiplies the weight (they stack).
const groupsOf = (s) => {
  const raw = [];
  if (s.weightMultiplier) raw.push(s.weightMultiplier);
  if (Array.isArray(s.weightMultipliers)) raw.push(...s.weightMultipliers);
  return raw
    .map((w) => ({ x: w.multiplier, cats: ((w.condition && w.condition.biomes) || []).map(catLabel).sort() }))
    .filter((g) => g.cats.length);
};

function main() {
  const V = JSON.parse(fs.readFileSync(VARIANTS, "utf8"));
  const B = JSON.parse(fs.readFileSync(BIOMES, "utf8"));
  const known = new Set(V.cobblemon.map((o) => o.id));

  // Vanilla overworld biomes only — the pack ships no biome mods, so terralith:* keys
  // in biome-spawns.json describe biomes that don't generate. `labelsOf` gives the
  // cobblemon categories a biome belongs to, which is how we evaluate condition.biomes.
  const overworld = Object.keys(B)
    .filter((id) => id.startsWith("minecraft:") && B[id].includes("any overworld"))
    .sort();
  const labelsOf = (id) => new Set([...B[id], readable(id)]);

  const matchesBiome = (refs, id) => {
    if (!refs || !refs.length) return true;
    const have = labelsOf(id);
    return refs.some((r) => r === "#cobblemon:is_overworld" || have.has(catLabel(r)));
  };
  // Effective weight of one spawn row in one biome: base weight × every matching group.
  const effWeight = (s, id) =>
    groupsOf(s).reduce((w, g) => (g.cats.some((c) => labelsOf(id).has(c)) ? w * g.x : w), s.weight);

  // ---- collect every uncommon fishing spawn in the pack (patterns + competitors) ----
  const uncommon = [];
  for (const f of fs.readdirSync(POOLDIR)) {
    if (!f.endsWith(".json")) continue;
    for (const s of JSON.parse(fs.readFileSync(path.join(POOLDIR, f), "utf8")).spawns || []) {
      if (s.spawnablePositionType !== "fishing" || s.bucket !== "uncommon") continue;
      uncommon.push(s);
    }
  }

  // Scenario gating. `structures` / `bobber` / `rodType` spawns are location- or
  // gear-specific and would inflate a generic pool, so they're excluded and counted.
  const skipped = uncommon.filter((s) => {
    const c = s.condition || {};
    return c.structures || c.bobber || c.rodType;
  }).length;
  const pool = uncommon.filter((s) => {
    const c = s.condition || {};
    return !c.structures && !c.bobber && !c.rodType;
  });

  // Surface = open sky, full sky light. Underground = covered, sky light 0.
  const SCEN = { surface: { sky: true, light: 15 }, underground: { sky: false, light: 0 } };
  const rowApplies = (s, sc, lure) => {
    const c = s.condition || {};
    if (c.minLureLevel !== undefined && lure < c.minLureLevel) return false;
    if (c.canSeeSky !== undefined && c.canSeeSky !== sc.sky) return false;
    if (c.minSkyLight !== undefined && (sc.light < c.minSkyLight || sc.light > c.maxSkyLight)) return false;
    return true;
  };

  // ---- patterns ----
  const karp = pool.filter((s) => s.pokemon.includes("magikarp_jump="));
  const byAspect = new Map();
  for (const s of karp) {
    const a = s.pokemon.split("magikarp_jump=")[1].trim();
    if ((s.condition || {}).minLureLevel !== 1) throw new Error(`${s.id}: minLureLevel != 1`);
    if (!byAspect.has(a)) byAspect.set(a, []);
    byAspect.get(a).push(s);
  }

  const patterns = [];
  for (const [aspect, rows] of [...byAspect].sort()) {
    const mid = variantId("magikarp", aspect), gid = variantId("gyarados", aspect);
    for (const id of [mid, gid]) if (!known.has(id)) throw new Error(`no variant for ${aspect}: ${id}`);
    const name = V.cobblemon.find((o) => o.id === mid).name;

    // Merged view for display: best multiplier per category, plus the Underground
    // multiplier implied by the skyLight 0-7 row (its weight / the plain row's).
    const best = new Map();
    for (const r of rows) for (const g of groupsOf(r)) for (const c of g.cats) {
      if (!best.has(c) || best.get(c) < g.x) best.set(c, g.x);
    }
    const darkRow = rows.find((r) => (r.condition || {}).minSkyLight === 0);
    const plain = rows.find((r) => (r.condition || {}).minSkyLight !== 0);
    if (darkRow) best.set("underground", darkRow.weight / plain.weight);

    patterns.push({
      aspect, name, magikarp: mid, gyarados: gid, base: plain.weight,
      boosts: [...best].map(([cat, x]) => ({ cat, x })).sort((a, b) => b.x - a.x || a.cat.localeCompare(b.cat)),
    });
  }

  // ---- per-biome uncommon fishing pool (with Lure I, which patterns require) ----
  const pools = {};
  for (const id of overworld) {
    const entry = {};
    for (const [scName, sc] of Object.entries(SCEN)) {
      const rows = pool.filter((s) => rowApplies(s, sc, 1) && matchesBiome((s.condition || {}).biomes, id));
      if (!rows.length) continue;
      const total = rows.reduce((t, s) => t + effWeight(s, id), 0);
      const w = {};
      for (const s of rows) {
        if (!s.pokemon.includes("magikarp_jump=")) continue;
        w[s.pokemon.split("magikarp_jump=")[1].trim()] = +effWeight(s, id).toFixed(3);
      }
      entry[scName] = { total: +total.toFixed(3), w };
    }
    if (Object.keys(entry).length) pools[readable(id)] = entry;
  }

  // category -> the vanilla biomes in it (for the guide's "where is that?" line)
  const cats = {};
  for (const cat of new Set(patterns.flatMap((p) => p.boosts.map((b) => b.cat)))) {
    if (cat === "underground") continue;
    cats[cat] = overworld.filter((id) => B[id].includes(cat)).map(readable);
  }

  const out = {
    _note:
      "Magikarp jump patterns, from COBBLEVERSE-DP-v29 spawn_pool_world. All are `fishing` spawns in the " +
      "`uncommon` bucket needing a Poké Rod with Lure I+ (minLureLevel 1); they can be fished in any overworld " +
      "biome, and `boosts` are the categories where each is 3x/5x likelier. `underground` is the skyLight<=7 " +
      "multiplier (depth/cover, NOT night — sky light is time-independent). Gyarados has no patterned spawns; " +
      "it inherits the pattern from the Magikarp it evolved from. `pools[biome][scenario]` gives the TOTAL " +
      "effective weight of every uncommon fishing spawn there (Lure I) and each pattern's share of it. " +
      "Spawns gated on structures / bobber type / a specific rod are excluded from the pool. " +
      "`typing` and `egg_group` baits reweight within the bucket and are NOT modelled — Starf Berry and the " +
      "apples carry neither, so their numbers are exact.",
    lureMin: 1, bucket: "uncommon", position: "fishing",
    buckets: BUCKETS, normalize: NORMALIZE, shinyRate: SHINY_RATE, baits: BAITS,
    categories: cats, patterns, pools,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`${patterns.length} patterns · ${Object.keys(cats).length} categories · ${Object.keys(pools).length} biomes -> ${OUT}`);
  console.log(`  uncommon fishing spawns: ${uncommon.length} (${karp.length} patterns, ${skipped} excluded: structure/bobber/rod-gated)`);
  const empty = Object.entries(cats).filter(([, v]) => !v.length).map(([k]) => k);
  if (empty.length) console.log(`  WARNING: categories with no vanilla biome: ${empty.join(", ")}`);
}
main();
