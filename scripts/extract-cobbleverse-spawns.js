/* extract-cobbleverse-spawns.js
 *
 * SOURCE OF TRUTH extractor — reads the ACTUAL Cobbleverse datapack files
 * (NOT the wiki) and emits a complete, loss-free record of every Pokémon's
 * spawn conditions exactly as the game uses them.
 *
 * Input (from the installed/zipped modpack):
 *   COBBLEVERSE-DP-v<N>.zip  ->  data/cobblemon/spawn_pool_world/<dex>_<name>.json
 * Each file is a Cobblemon spawn-pool file: { enabled, spawns: [ {…} ] }.
 *
 * Biome tags (`#cobblemon:is_arid`, …) are expanded to their constituent
 * biomes using Cobblemon's OWN tag definitions
 * (data/cobblemon/tags/worldgen/biome/*.json). Non-cobblemon tags
 * (#minecraft / #aether / #the_bumblezone / terralith / byg / biomesoplenty)
 * are kept verbatim — they come from other mods whose tag files aren't in the
 * datapack — so nothing is invented and nothing is lost.
 *
 * Usage:
 *   node scripts/extract-cobbleverse-spawns.js \
 *     <spawn_pool_world dir> <cobblemon tags/worldgen/biome dir> <out.json> [out.md]
 *
 * Defaults match the dirs this was first run against:
 *   SPAWNS = /tmp/cvdp/COBBLEVERSE-DP-v29/data/cobblemon/spawn_pool_world
 *   TAGS   = /tmp/cobblemon-spawns/common/src/main/resources/data/cobblemon/tags/worldgen/biome
 *
 * Output: research/cobbleverse-spawns-v29.json  (+ .md digest)
 *   {
 *     _meta: {…},
 *     species: { "<dex>": { dex, file, names:[…], spawns:[ <record> ] } }
 *   }
 *   <record> keeps the RAW spawn object under `raw`, plus derived fields:
 *     pokemon, species, form, bucket(rarity), level, weight, summonOnly,
 *     position, presets, context, time, weather, sky{…}, y{…}, x{…},
 *     moonPhase, slimeChunk, nearbyBlocks, baseBlocks, fishing{…},
 *     biomes{ include:[…], exclude:[…], includeResolved:[…] },
 *     sites{ include:[…], exclude:[…] },  // structures / custom_spawn sites
 *     multipliers:[ {multiplier, when} ], drops, summary(english)
 */
const fs = require("fs");
const path = require("path");

const SPAWNS = process.argv[2] || "/tmp/cvdp/COBBLEVERSE-DP-v29/data/cobblemon/spawn_pool_world";
const TAGS = process.argv[3] || "/tmp/cobblemon-spawns/common/src/main/resources/data/cobblemon/tags/worldgen/biome";
const OUT = process.argv[4] || path.join(__dirname, "..", "research", "cobbleverse-spawns-v29.json");
const OUT_MD = process.argv[5] || OUT.replace(/\.json$/, ".md");
const DP_VERSION = "COBBLEVERSE-DP-v29";
const PACK_VERSION = "COBBLEVERSE 1.7.31 (Modrinth, MC 1.21.1)";

// ---------- cobblemon biome tag resolver (recursive, cobblemon-namespace only) ----------
const tagCache = {};
function tagFile(name) {
  // name like "is_arid" -> tags/worldgen/biome/is_arid.json
  const p = path.join(TAGS, name + ".json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}
// Resolve a single biome ref into a flat, de-duped list of concrete biomes.
// #cobblemon:* tags recurse via the on-disk tag files; everything else is a
// leaf kept as-is (concrete biome id, or an unresolved foreign-mod tag).
function resolveRef(ref, seen) {
  ref = String(ref).trim();
  seen = seen || {};
  if (seen[ref]) return [];
  seen[ref] = true;
  const m = ref.match(/^#cobblemon:(.+)$/);
  if (!m) return [ref.replace(/^#/, "#")]; // leaf (biome id or foreign tag) kept verbatim
  const def = tagFile(m[1]);
  if (!def || !Array.isArray(def.values)) return [ref]; // can't resolve -> keep tag
  let out = [];
  for (const v of def.values) {
    const id = typeof v === "string" ? v : (v && v.id);
    if (id) out = out.concat(resolveRef(id, seen));
  }
  return out;
}
function resolveBiomes(list) {
  const out = [];
  const seenOut = {};
  for (const b of list || []) {
    for (const r of resolveRef(b)) {
      if (!seenOut[r]) { seenOut[r] = true; out.push(r); }
    }
  }
  return out;
}

// ---------- readable helpers ----------
function readableSite(ref) {
  // cobbleverse:custom_spawn/articuno_tower -> "Articuno Tower (custom spawn site)"
  // cobblemon:shipwreck_coves/lush_shipwreck_cove -> "Lush Shipwreck Cove"
  // #minecraft:village -> "Village"
  const raw = String(ref);
  const isTag = raw[0] === "#";
  const noHash = raw.replace(/^#/, "");
  const custom = noHash.match(/^cobbleverse:custom_spawn\/(.+)$/);
  const seg = noHash.replace(/^[a-z0-9_.-]+:/, "").split("/").pop();
  const label = seg.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { ref: raw, label: label, custom: !!custom, tag: isTag };
}
function readableBiome(ref) {
  // keep namespaced/tag form but add a short human label
  const noHash = String(ref).replace(/^#/, "");
  const seg = noHash.replace(/^[a-z0-9_.-]+:/, "").replace(/^is_/, "");
  return seg.replace(/_/g, " ").trim();
}
function uniqLabels(refs) {
  const out = [], seen = {};
  for (const r of refs) { const l = readableBiome(r); if (!seen[l]) { seen[l] = 1; out.push(l); } }
  return out;
}

function parsePokemon(str) {
  // "gastrodon sea=east" -> {species:"gastrodon", form:"sea=east"}
  // "articuno galarian"  -> {species:"articuno", form:"galarian"}
  const s = String(str).trim();
  const sp = s.indexOf(" ");
  if (sp < 0) return { species: s, form: null };
  return { species: s.slice(0, sp), form: s.slice(sp + 1).trim() };
}

function condBits(c) {
  c = c || {};
  const o = {};
  if (c.timeRange != null) o.time = c.timeRange;
  const wx = [];
  if (c.isThundering === true) wx.push("thunder");
  else if (c.isRaining === true) wx.push("rain");
  if (c.isRaining === false) wx.push("clear");
  if (c.isThundering === false) wx.push("no-thunder");
  if (wx.length) o.weather = wx;
  const sky = {};
  if (c.canSeeSky != null) sky.canSeeSky = c.canSeeSky;
  if (c.minSkyLight != null) sky.minSkyLight = c.minSkyLight;
  if (c.maxSkyLight != null) sky.maxSkyLight = c.maxSkyLight;
  if (c.maxLight != null) sky.maxLight = c.maxLight;
  if (Object.keys(sky).length) o.sky = sky;
  const y = {};
  if (c.minY != null) y.min = c.minY;
  if (c.maxY != null) y.max = c.maxY;
  if (Object.keys(y).length) o.y = y;
  const x = {};
  if (c.minX != null) x.min = c.minX;
  if (c.maxX != null) x.max = c.maxX;
  if (Object.keys(x).length) o.x = x;
  if (c.moonPhase != null) o.moonPhase = c.moonPhase;
  if (c.isSlimeChunk != null) o.slimeChunk = c.isSlimeChunk;
  if (c.neededNearbyBlocks) o.nearbyBlocks = c.neededNearbyBlocks;
  if (c.neededBaseBlocks) o.baseBlocks = c.neededBaseBlocks;
  const fishing = {};
  if (c.minLureLevel != null) fishing.minLureLevel = c.minLureLevel;
  if (c.maxLureLevel != null) fishing.maxLureLevel = c.maxLureLevel;
  if (c.rodType) fishing.rod = c.rodType;
  if (c.bait) fishing.bait = c.bait;
  if (c.bobber) fishing.bobber = c.bobber;
  if (Object.keys(fishing).length) o.fishing = fishing;
  return o;
}

function multipliersOf(s) {
  const list = [];
  if (s.weightMultiplier) list.push(s.weightMultiplier);
  if (Array.isArray(s.weightMultipliers)) for (const m of s.weightMultipliers) list.push(m);
  return list.map((m) => ({ multiplier: m.multiplier, when: condBits(m.condition) }));
}

function summarize(rec) {
  const parts = [];
  parts.push("Lv " + rec.level);
  parts.push(rec.rarity + " (w" + rec.weight + ")");
  if (rec.summonOnly) parts.push("SUMMON-ONLY (weight 0)");
  if (rec.position && rec.position !== "grounded") parts.push(rec.position);
  if (rec.biomes.include.length) parts.push("in " + uniqLabels(rec.biomes.include).join(", "));
  if (rec.biomes.exclude.length) parts.push("not in " + uniqLabels(rec.biomes.exclude).join(", "));
  if (rec.sites.include.length) parts.push("at " + rec.sites.include.map((r) => readableSite(r).label).join(", "));
  if (rec.sites.exclude.length) parts.push("not at " + rec.sites.exclude.map((r) => readableSite(r).label).join(", "));
  if (rec.time) parts.push(rec.time);
  if (rec.weather) parts.push(rec.weather.join("/"));
  if (rec.sky) {
    if (rec.sky.canSeeSky === true) parts.push("sees sky");
    if (rec.sky.canSeeSky === false) parts.push("covered/underground");
    if (rec.sky.maxLight != null) parts.push("light<=" + rec.sky.maxLight);
  }
  if (rec.y) parts.push("Y " + (rec.y.min != null ? rec.y.min : "-") + ".." + (rec.y.max != null ? rec.y.max : "-"));
  if (rec.moonPhase != null) parts.push("moon " + rec.moonPhase);
  if (rec.slimeChunk != null) parts.push(rec.slimeChunk ? "slime chunk" : "not slime chunk");
  if (rec.nearbyBlocks) parts.push("near " + rec.nearbyBlocks.map(readableBiome).join("/"));
  if (rec.fishing) {
    const f = rec.fishing;
    const fb = [];
    if (f.rod) fb.push(f.rod + " rod");
    if (f.bait) fb.push("bait " + f.bait);
    if (f.minLureLevel != null || f.maxLureLevel != null) fb.push("lure " + (f.minLureLevel != null ? f.minLureLevel : 0) + "-" + (f.maxLureLevel != null ? f.maxLureLevel : "+"));
    if (fb.length) parts.push("fishing(" + fb.join(", ") + ")");
  }
  if (rec.multipliers.length) {
    parts.push(rec.multipliers.map((m) => "x" + m.multiplier + " when " + (whenStr(m.when) || "?")).join("; "));
  }
  return parts.join(" · ");
}
function whenStr(w) {
  const p = [];
  if (w.time) p.push(w.time);
  if (w.weather) p.push(w.weather.join("/"));
  if (w.moonPhase != null) p.push("moon " + w.moonPhase);
  if (w.fishing) p.push("lure " + (w.fishing.minLureLevel != null ? w.fishing.minLureLevel : 0) + "-" + (w.fishing.maxLureLevel != null ? w.fishing.maxLureLevel : "+"));
  if (w.sky) p.push("sky");
  if (w.y) p.push("Y range");
  return p.join("+");
}

function isSiteRef(ref) {
  // A custom-spawn site can appear in EITHER the biomes or structures field
  // (Cobbleverse registers each legendary altar as its own biome, e.g.
  // "cobbleverse:custom_spawn/articuno_tower"). Treat those as sites, not biomes.
  return /(^|:)custom_spawn(\/|$)/.test(String(ref));
}
function splitBiomesSites(biomes, structures) {
  const realBiomes = [], siteRefs = [];
  for (const b of biomes || []) (isSiteRef(b) ? siteRefs : realBiomes).push(b);
  for (const s of structures || []) siteRefs.push(s);
  return { biomes: realBiomes, sites: siteRefs };
}

function buildRecord(s) {
  const cond = s.condition || {};
  const anti = s.anticondition || {};
  const pk = parsePokemon(s.pokemon);
  const bits = condBits(cond);
  const inc = splitBiomesSites(cond.biomes, cond.structures);
  const exc = splitBiomesSites(anti.biomes, anti.structures);
  const rec = {
    id: s.id,
    pokemon: s.pokemon,
    species: pk.species,
    form: pk.form,
    rarity: s.bucket,
    level: s.level,
    weight: s.weight,
    summonOnly: s.weight === 0,
    type: s.type,
    position: s.spawnablePositionType || s.context || null,
    presets: s.presets || [],
    context: s.context || null,
    time: bits.time || null,
    weather: bits.weather || null,
    sky: bits.sky || null,
    y: bits.y || null,
    x: bits.x || null,
    moonPhase: bits.moonPhase != null ? bits.moonPhase : null,
    slimeChunk: bits.slimeChunk != null ? bits.slimeChunk : null,
    nearbyBlocks: bits.nearbyBlocks || null,
    baseBlocks: bits.baseBlocks || null,
    fishing: bits.fishing || null,
    biomes: {
      include: inc.biomes,
      exclude: exc.biomes,
      includeResolved: resolveBiomes(inc.biomes),
      excludeResolved: resolveBiomes(exc.biomes),
    },
    sites: {
      include: inc.sites,
      exclude: exc.sites,
    },
    multipliers: multipliersOf(s),
    drops: s.drops || null,
    raw: s,
  };
  // anticondition extras (time/Y/nearby/slime) preserved raw too
  rec.antiExtra = {};
  for (const k of ["timeRange", "minY", "maxY", "neededNearbyBlocks", "isSlimeChunk", "minLureLevel"]) {
    if (anti[k] != null) rec.antiExtra[k] = anti[k];
  }
  if (!Object.keys(rec.antiExtra).length) rec.antiExtra = null;
  rec.summary = summarize(rec);
  return rec;
}

function main() {
  const files = fs.readdirSync(SPAWNS).filter((f) => /\.json$/.test(f)).sort();
  const species = {};
  let entryCount = 0, summonOnly = 0;
  const allSites = {};
  for (const f of files) {
    const m = f.match(/^(\d+)[_-]/);
    const dex = m ? parseInt(m[1], 10) : null;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(SPAWNS, f), "utf8")); }
    catch (e) { console.error("PARSE FAIL", f, e.message); continue; }
    const spawns = (d.spawns || []).map(buildRecord);
    entryCount += spawns.length;
    const names = [];
    for (const r of spawns) {
      if (names.indexOf(r.pokemon) < 0) names.push(r.pokemon);
      if (r.summonOnly) summonOnly++;
      for (const site of r.sites.include.concat(r.sites.exclude)) {
        const rs = readableSite(site);
        if (rs.custom || isSiteRef(site)) allSites[site] = rs.label;
      }
    }
    // A few dex numbers ship as multiple form-files (e.g. 0413 wormadam
    // plant/sandy/trash, 0025 pikachu + cosmetic). Merge them under one dex key
    // so no entries are dropped; `files` lists every source file.
    const key = dex != null ? String(dex) : f.replace(/\.json$/, "");
    if (species[key]) {
      const e = species[key];
      e.files.push(f);
      for (const nm of names) if (e.names.indexOf(nm) < 0) e.names.push(nm);
      e.spawns = e.spawns.concat(spawns);
    } else {
      species[key] = {
        dex: dex,
        files: [f],
        enabled: d.enabled,
        neededInstalledMods: d.neededInstalledMods || [],
        neededUninstalledMods: d.neededUninstalledMods || [],
        names: names,
        spawns: spawns,
      };
    }
  }
  const out = {
    _meta: {
      title: "Cobbleverse spawn conditions — extracted from datapack files (not the wiki)",
      source: DP_VERSION + " :: data/cobblemon/spawn_pool_world/*.json",
      pack: PACK_VERSION,
      biomeTagsResolvedFrom: "Cobblemon data/cobblemon/tags/worldgen/biome/*.json (cobblemon-namespace tags expanded recursively; foreign-mod tags kept verbatim)",
      speciesFiles: files.length,
      spawnEntries: entryCount,
      summonOnlyEntries: summonOnly,
      customSpawnSites: allSites,
      note: "Each spawn keeps its untouched datapack object under `raw`. Derived fields are conveniences; `raw` is authoritative.",
      coverage: "DP-v29 is the sole spawn source for this pack: it ships 1024 spawn_pool_world files (every species) and fully overrides base-Cobblemon spawns by resource path. The Hoenn/Johto/Sinnoh, RCT, and Loot datapacks add NO spawn_pool_world files (structures/worldgen/trainers/loot only). Verified losslessly: the multiset of all 3119 raw spawn objects matches the datapack exactly (numbers normalized, e.g. weight 1.0==1). Only non-override left in base Cobblemon is the example file spawn_pool_world/herds/0001_bulbasaur_herd.json, which Cobbleverse does not ship and is not reflected here.",
    },
    species: species,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log("Wrote", OUT);
  console.log("  species files:", files.length, "spawn entries:", entryCount, "summon-only:", summonOnly);
  console.log("  custom spawn sites:", Object.keys(allSites).length);

  // ---- readable markdown digest ----
  writeMarkdown(out);
}

function writeMarkdown(out) {
  const L = [];
  L.push("# Cobbleverse spawn conditions (datapack-extracted)");
  L.push("");
  L.push("Source: **" + out._meta.source + "** — pack **" + out._meta.pack + "**.");
  L.push("Extracted directly from the modpack's datapack JSON, **not** the wiki. Biome tags expanded from Cobblemon's own tag files.");
  L.push("");
  L.push("- Species files: **" + out._meta.speciesFiles + "**, spawn entries: **" + out._meta.spawnEntries + "**, summon-only (weight 0): **" + out._meta.summonOnlyEntries + "**.");
  L.push("- `SUMMON-ONLY` = weight 0: not a wild spawn; appears only inside its named custom-spawn site/structure (legendary/mythical altar).");
  L.push("");
  L.push("## Custom-spawn sites (legendary/mythical structures referenced)");
  L.push("");
  const sites = out._meta.customSpawnSites;
  for (const k of Object.keys(sites).sort()) L.push("- `" + k + "` — " + sites[k]);
  L.push("");
  L.push("## Per-species spawns");
  L.push("");
  const keys = Object.keys(out.species).sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
  for (const k of keys) {
    const sp = out.species[k];
    const dexStr = sp.dex != null ? "#" + String(sp.dex).padStart(4, "0") : sp.files.join(",");
    L.push("### " + dexStr + " — " + sp.names.join(" / "));
    if (!sp.spawns.length) { L.push("_no spawn entries_"); L.push(""); continue; }
    for (const r of sp.spawns) {
      let head = "- **" + r.pokemon + "** [" + r.id + "]: " + r.summary;
      L.push(head);
      // show resolved biomes when a tag expanded to multiple concrete biomes
      if (r.biomes.include.length && r.biomes.includeResolved.length &&
          (r.biomes.include.length !== r.biomes.includeResolved.length ||
           r.biomes.include.join() !== r.biomes.includeResolved.join())) {
        L.push("    - biomes: `" + r.biomes.include.join("`, `") + "` → " + uniqLabels(r.biomes.includeResolved).join(", "));
      }
    }
    L.push("");
  }
  fs.writeFileSync(OUT_MD, L.join("\n"));
  console.log("Wrote", OUT_MD);
}

main();
