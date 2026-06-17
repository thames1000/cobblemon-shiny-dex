/**
 * Build cobbleverse-spawns.csv in the same column layout as the base-Cobblemon
 * "Cobblemon Spawn Data" sheet, but from the full Cobbleverse v29 datapack
 * extract — so it covers ALL species (every gen, paradox, legendaries), not just
 * the ~338 base Cobblemon implements.
 *
 * Columns (mirrors base):
 *   Gen, No., Pokémon, Biome, Excluded, Time, Weather, Context, Preset,
 *   Requirements, Bucket, Weight, Lv. Min, Lv. Max, canSeeSky
 *
 * One row per biome (base splits Charmander into Basalt Deltas / Hills / Volcanic).
 * Conditions base lacks a column for (nearby blocks, Y range, moon, fishing rod,
 * light level, structures, weight multipliers) are folded into Requirements, the
 * same column base used for Porygon2's "PC".
 *
 *   node scripts/build-cobbleverse-spawns-csv.js
 */
const fs = require("fs");
const path = require("path");

const RESEARCH = path.join(__dirname, "..", "research", "cobbleverse-spawns-v29.json");
const SPECIES = path.join(__dirname, "..", "js", "data", "species.json");
const HITBOX = path.join(__dirname, "..", "research", "cobblemon-hitboxes.json");
const OUT = path.join(__dirname, "..", "cobbleverse-spawns.csv");

const COLS = ["Gen", "No.", "Pokémon", "Biome", "Excluded", "Time", "Weather",
  "Context", "Preset", "Requirements", "Bucket", "Weight", "Lv. Min", "Lv. Max", "canSeeSky",
  "Hitbox W", "Hitbox H", "Hitbox Fixed", "Datapack"];

// Server-side datapack spawns (committed under research/legendary-encounters/).
// These are NOT in the base Cobbleverse extract — they require the datapack to be
// installed — so they're appended with the Datapack column set to the pack name.
const DATAPACKS = [
  { dir: path.join(__dirname, "..", "research", "legendary-encounters"), label: "Legendary Encounters" },
];

// Form-name normaliser shared with build-hitboxes.js: maps regional demonyms to
// the species form stem ("alolan"->"alola") so spawn forms match species forms.
const REGION_ALIAS = { alolan: "alola", galarian: "galar", hisuian: "hisui", paldean: "paldea", kantonian: "kanto", unovan: "unova", valencian: "valencia" };
const normForm = (s) => { s = String(s).toLowerCase().trim(); return REGION_ALIAS[s] || s; };
// Pick the hitbox for a spawn: a divergent form hitbox if the spawn's form matches
// one (e.g. Alolan Exeggutor 1.6×11), else the species hitbox.
function hitboxFor(H, dex, rawForm) {
  const fset = H.forms[dex];
  if (fset && rawForm) {
    const toks = String(rawForm).split(/\s+/).map((t) => { const i = t.indexOf("="); return normForm(i < 0 ? t : t.slice(i + 1)); });
    const hit = fset.find((f) => toks.includes(f.form));
    if (hit) return hit;
  }
  return H.byDex[dex] || { w: "", h: "", fixed: "" };
}

const titleWords = (s) => String(s).replace(/_/g, " ").split(" ")
  .map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ").trim();

// A biome tag -> base-style Title Case category. Disable markers -> null (skip).
function biomeLabel(ref) {
  if (!ref) return null;
  ref = String(ref).trim();
  if (/not_spawn/.test(ref)) return null;
  const m = ref.match(/^#?([a-z0-9_.-]+):(.+)$/);
  if (!m) return titleWords(ref);
  let body = m[2];
  if (body === "is_overworld") return "Overworld";
  const neth = body.match(/^nether\/is_(.+)$/);
  if (neth) return "Nether " + titleWords(neth[1]);
  return titleWords(body.replace(/^is_/, ""));
}
const presetLabel = (p) => p.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join("_");
const blockName = (b) => titleWords(String(b).replace(/^#?[a-z0-9_.-]+:/, ""));
const siteName = (s) => titleWords(String(s).replace(/^#?[a-z0-9_.-]+:/, ""));

function timeLabel(t) { return !t ? "any" : t === "dusk" ? "twilight" : t; }
function weatherLabel(arr) {
  if (!arr || !arr.length) return "any";
  return arr.map((w) => w === "thunder" ? "storm" : w).join("/");
}
function formLabel(form) {
  if (!form) return "";
  return String(form).split(/\s+/).map((tok) => {
    const i = tok.indexOf("=");
    if (i < 0) return titleWords(tok);
    const k = tok.slice(0, i), v = tok.slice(i + 1);
    if (k === "region_bias") return titleWords(v);
    if (k === "sea") return titleWords(v) + " Sea";
    if (k === "striped") return titleWords(v) + "-Striped";
    return titleWords(v);
  }).filter(Boolean).join(" ");
}

// Everything base has no column for, collapsed into one Requirements string.
function requirements(s) {
  const r = [];
  if (s.nearbyBlocks && s.nearbyBlocks.length) r.push("near " + s.nearbyBlocks.map(blockName).join("/"));
  if (s.baseBlocks && s.baseBlocks.length) r.push("on " + s.baseBlocks.map(blockName).join("/"));
  if (s.y && (s.y.min != null || s.y.max != null)) {
    r.push("Y " + (s.y.min != null && s.y.max != null ? s.y.min + ".." + s.y.max
      : s.y.max != null ? "≤" + s.y.max : "≥" + s.y.min));
  }
  if (s.moonPhase != null) r.push("moon " + s.moonPhase);
  if (s.slimeChunk === true) r.push("slime chunk");
  if (s.sky) {
    const k = s.sky;
    if (k.maxSkyLight != null && k.maxSkyLight < 15) r.push(k.minSkyLight ? `light ${k.minSkyLight}-${k.maxSkyLight}` : `light ≤${k.maxSkyLight}`);
    else if (k.minSkyLight != null && k.minSkyLight > 0) r.push(`light ≥${k.minSkyLight}`);
    if (k.maxLight != null && k.maxLight < 15) r.push(`block light ≤${k.maxLight}`);
  }
  if (s.fishing) {
    const f = s.fishing, fb = [];
    if (f.rod) fb.push(blockName(f.rod) + " rod");
    if (f.bait) fb.push("bait");
    if (f.minLureLevel != null) fb.push("lure " + f.minLureLevel);
    if (fb.length) r.push("fishing: " + fb.join(", "));
  }
  const sites = (s.sites && s.sites.include) || [];
  if (sites.length) r.push("at: " + sites.map(siteName).join("/"));
  for (const m of s.multipliers || []) {
    if (m.multiplier && m.multiplier !== 1) {
      const w = m.when && (m.when.weather ? m.when.weather.join("/") : m.when.time
        || (m.when.moonPhase != null ? "moon " + m.when.moonPhase : ""));
      r.push("×" + m.multiplier + (w ? " " + w : ""));
    }
  }
  return r.join("; ");
}

function csvCell(v) {
  v = v == null ? "" : String(v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

// Emit the CSV rows for one spawn (one per included biome). `s` is in the
// research-extract spawn shape; `datapack` is "" for base spawns or a pack name.
// Returns true if any row was emitted.
function emitSpawn(rows, seen, GEN, H, dex, baseName, s, datapack) {
  const form = formLabel(s.form);
  const name = form ? `${baseName} (${form})` : baseName;
  const lvl = String(s.level || "").split("-");
  const lvMin = lvl[0] || "";
  const lvMax = lvl[1] || lvl[0] || "";
  const sky = s.sky && s.sky.canSeeSky === true ? "TRUE" : s.sky && s.sky.canSeeSky === false ? "FALSE" : "";
  const hb = hitboxFor(H, dex, s.form);
  const common = {
    Gen: GEN[dex] || "", "No.": dex, "Pokémon": name,
    Excluded: ((s.biomes.exclude || []).map(biomeLabel).filter(Boolean)).join(", "),
    Time: timeLabel(s.time), Weather: weatherLabel(s.weather),
    Context: s.position || "grounded",
    Preset: (s.presets || []).map(presetLabel).join(", "),
    Requirements: requirements(s),
    Bucket: s.rarity || "", Weight: s.weight, "Lv. Min": lvMin, "Lv. Max": lvMax,
    canSeeSky: sky,
    "Hitbox W": hb.w, "Hitbox H": hb.h,
    "Hitbox Fixed": hb.fixed === true ? "TRUE" : hb.fixed === false ? "FALSE" : "",
    Datapack: datapack || "",
  };
  // One row per biome category (base style). No biome (summon/structure-only)
  // still yields a single row so legendaries etc. are never dropped.
  const biomes = [...new Set((s.biomes.include || []).map(biomeLabel).filter(Boolean))];
  const targets = biomes.length ? biomes : [""];
  let emitted = false;
  for (const b of targets) {
    const row = Object.assign({ Biome: b }, common);
    const line = COLS.map((c) => csvCell(row[c]));
    const dedupKey = line.join("");
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    rows.push(line.join(","));
    emitted = true;
  }
  return emitted;
}

// Convert one raw Cobblemon spawn_pool_world spawn (datapack format) into the
// research-extract spawn shape that emitSpawn() consumes.
function datapackSpawnToResearch(sp) {
  const c = sp.condition || {};
  return {
    form: null,
    level: sp.level || "",
    weight: sp.weight != null ? sp.weight : "",
    rarity: sp.bucket || "",
    position: sp.context || "grounded",
    presets: sp.presets || [],
    time: c.timeRange || null,
    weather: c.weather ? [c.weather] : null,
    sky: c.canSeeSky === undefined ? null : { canSeeSky: c.canSeeSky },
    biomes: { include: c.biomes || [], exclude: c.excludedBiomes || [] },
  };
}

function main() {
  const research = JSON.parse(fs.readFileSync(RESEARCH, "utf8")).species;
  const species = JSON.parse(fs.readFileSync(SPECIES, "utf8"));
  const H = JSON.parse(fs.readFileSync(HITBOX, "utf8"));
  const GEN = {}, NAME = {};
  const dexByNorm = {}, dexByBase = {};
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");
  species.forEach((s) => {
    GEN[s.dex] = s.gen; NAME[s.dex] = s.name;
    dexByNorm[norm(s.name)] = s.dex;
    const base = norm(String(s.name).split("-")[0]);
    if (!(base in dexByBase)) dexByBase[base] = s.dex;
  });

  // Order by dex, then by the record's natural order.
  const keys = Object.keys(research).sort((a, b) => (research[a].dex || 0) - (research[b].dex || 0));
  const rows = [];
  const seen = new Set();
  let speciesOut = 0;

  for (const key of keys) {
    const sp = research[key];
    const dex = sp.dex;
    const baseName = titleWords((NAME[dex] || sp.name || String(key)).replace(/-/g, " "));
    let emittedForSpecies = false;
    for (const s of sp.spawns || []) {
      if (emitSpawn(rows, seen, GEN, H, dex, baseName, s, "")) emittedForSpecies = true;
    }
    if (emittedForSpecies) speciesOut++;
  }

  // Append committed datapack spawns (require the datapack to be installed).
  let dpRows = 0; const dpUnmatched = [];
  for (const pack of DATAPACKS) {
    if (!fs.existsSync(pack.dir)) continue;
    for (const file of fs.readdirSync(pack.dir).filter((f) => f.endsWith(".json")).sort()) {
      let data; try { data = JSON.parse(fs.readFileSync(path.join(pack.dir, file), "utf8")); } catch (_) { continue; }
      if (!data.enabled || !Array.isArray(data.spawns)) continue;
      for (const raw of data.spawns) {
        if (raw.type && raw.type !== "pokemon") continue;
        const nm = String(raw.pokemon || "").replace(/^[a-z0-9_.-]+:/, "");
        const dex = dexByNorm[norm(nm)] || dexByBase[norm(nm)];
        if (!dex) { dpUnmatched.push(raw.pokemon); continue; }
        const baseName = titleWords((NAME[dex] || nm).replace(/-/g, " "));
        const before = rows.length;
        emitSpawn(rows, seen, GEN, H, dex, baseName, datapackSpawnToResearch(raw), pack.label);
        dpRows += rows.length - before;
      }
    }
  }

  fs.writeFileSync(OUT, COLS.map(csvCell).join(",") + "\n" + rows.join("\n") + "\n");
  console.log("Wrote", OUT);
  console.log("  species with >=1 row:", speciesOut, "| total rows:", rows.length, "| datapack rows:", dpRows);
  if (dpUnmatched.length) console.log("  UNMATCHED datapack species:", dpUnmatched);
}
main();
