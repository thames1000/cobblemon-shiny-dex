/* build-spawns-datapack.js
 *
 * Regenerate js/data/spawns.json (the Spawns tab's data) from the REAL
 * Cobbleverse datapack extraction (research/cobbleverse-spawns-v29.json),
 * NOT the wiki. Replaces the wiki-derived spawns.json with the actual
 * spawn-pool conditions.
 *
 * Two hard rules from the request:
 *  1. Use the datapack as the source of truth for spawn conditions
 *     (biomes, rarity, level, weight, time, weather, sky, structures, position,
 *      Y/moon/slime/fishing notes, weight-multiplier boosts).
 *  2. DO NOT include biomes that don't exist in THIS modpack. The pack ships
 *     NO biome mods (no Aether / Bumblezone / BYG / Biomes O' Plenty; Terralith
 *     is "credits only"), so the only real overworld biomes are vanilla
 *     Minecraft ones. Every spawn condition that points only at a foreign-mod
 *     biome — or a #cobblemon category that resolves to foreign biomes only
 *     (is_sky = Aether, is_tropical_island, is_volcanic, …) — is dropped.
 *
 * Quest-obtain details (gating item / radar / prerequisite) and Raid-Den-boss
 * flags are NOT in spawn_pool_world, so they're carried over from the existing
 * spawns.json by dex (still the best source for that non-spawn metadata).
 *
 * Usage:
 *   node scripts/build-spawns-datapack.js \
 *     [research json] [cobblemon biome-tag dir] [old spawns.json] [out spawns.json]
 */
const fs = require("fs");
const path = require("path");

const RESEARCH = process.argv[2] || path.join(__dirname, "..", "research", "cobbleverse-spawns-v29.json");
const TAGS = process.argv[3] || "/tmp/cobblemon-spawns/common/src/main/resources/data/cobblemon/tags/worldgen/biome";
const OLD = process.argv[4] || path.join(__dirname, "..", "js", "data", "spawns.json");
const OUT = process.argv[5] || path.join(__dirname, "..", "js", "data", "spawns.json");
const REPORT = path.join(__dirname, "..", "research", "spawns-comparison.md");

// ---------- cobblemon biome tag resolver (to test biome existence) ----------
const tagCache = {};
function tagDef(name) {
  if (name in tagCache) return tagCache[name];
  const p = path.join(TAGS, name + ".json");
  tagCache[name] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  return tagCache[name];
}
function resolveRef(ref, seen) {
  ref = String(ref).trim();
  seen = seen || {};
  if (seen[ref]) return [];
  seen[ref] = true;
  const m = ref.match(/^#cobblemon:(.+)$/);
  if (!m) return [ref.replace(/^#/, "")];
  const def = tagDef(m[1]);
  if (!def || !Array.isArray(def.values)) return [ref];
  let out = [];
  for (const v of def.values) {
    const id = typeof v === "string" ? v : (v && v.id);
    if (id) out = out.concat(resolveRef(id, seen));
  }
  return out;
}
// A biome ref "exists" in this pack iff it resolves to at least one
// vanilla (minecraft:) leaf. Foreign-mod biomes/tags resolve to nothing real.
function refExists(ref) {
  if (/^#?minecraft:/.test(ref)) return true; // vanilla biome or vanilla tag
  for (const leaf of resolveRef(ref)) if (/^minecraft:/.test(leaf)) return true;
  return false;
}

// ---------- label helpers ----------
function norm(ref) {
  // Datapack has a couple of un-prefixed tags ("is_warm_ocean"); treat bare
  // is_*/nether/is_* as #cobblemon: tags.
  if (/^is_/.test(ref) || /^nether\/is_/.test(ref)) return "#cobblemon:" + ref;
  return ref;
}
function readable(seg) { return String(seg).replace(/_/g, " ").trim(); }
function isPseudo(label) { return label === "any overworld" || label === "any biome"; }

// A biome ref -> a readable label that EXISTS in this pack, or null to drop.
function biomeLabel(rawRef) {
  const ref = norm(rawRef);
  if (/not_spawn|^not spawn$/.test(ref)) return null;       // disable marker
  if (!refExists(ref)) return null;                          // foreign-mod biome
  const tag = ref.match(/^#?([a-z0-9_.-]+):(.+)$/);
  if (!tag) return readable(ref);
  const ns = tag[1], body = tag[2];
  const isTag = ref[0] === "#";
  if (!isTag) {
    // concrete biome id (only vanilla survives refExists)
    return ns === "minecraft" ? readable(body) : null;
  }
  // tag -> category label
  if (body === "is_overworld") return "any overworld";
  if (body === "has_block/mud") return "mangrove swamp";
  const neth = body.match(/^nether\/is_(.+)$/);
  if (neth) return "nether " + readable(neth[1]);
  return readable(body.replace(/^is_/, ""));
}

// ---------- form / regional-variant labels ----------
const REGION = {
  galarian: "Galarian", alolan: "Alolan", hisuian: "Hisuian", paldean: "Paldean",
  valencian: "Valencian", kantonian: "Kantonian", unovan: "Unovan", hisui: "Hisuian",
  alola: "Alolan", galar: "Galarian", kanto: "Kantonian", unova: "Unovan",
};
// Cosmetic aspect keys: pure aesthetics that don't change where a mon spawns.
// Map them to no form so identical-signature entries collapse into one row.
const COSMETIC = {
  character: 1, magikarp_jump: 1, special_spots: 1, face_spots: 1, face_spots2: 1,
  meteor_shield: 1, core_color: 1, cosplay: 1, paint_color: 1, mooshtank: 1,
  percent_cells: 1, tympole_pattern: 1, wooper_heart: 1, whiscash_nero: 1,
  vivillon_wings: 1, snake_pattern: 1,
};
function titlecase(s) { return String(s).replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim(); }
function aspectLabel(k, v) {
  if (COSMETIC[k]) return "";
  switch (k) {
    case "region_bias": return REGION[v] || (titlecase(v) + " form");
    case "sea": return titlecase(v) + " Sea";
    case "striped": return titlecase(v) + "-Striped";
    case "flower": return titlecase(v) + " Flower";
    case "bagworm_cloak": case "cloak": return titlecase(v) + " Cloak";
    case "maushold_family": return "Family of " + titlecase(v);
    case "dance_style": return titlecase(v) + " Style";
    case "snake_pattern": return "";
    case "bull_breed": return titlecase(v);
    case "gender": return titlecase(v);
    default: return titlecase(v); // wolf_form, sword_form, blossom_form, forecast, *_authenticity, ...
  }
}
function formLabel(form) {
  if (!form) return "";
  const parts = [];
  for (const tok of String(form).split(/\s+/)) {
    if (tok.indexOf("=") >= 0) { const i = tok.indexOf("="); parts.push(aspectLabel(tok.slice(0, i), tok.slice(i + 1))); }
    else parts.push(REGION[tok] || titlecase(tok));
  }
  return parts.filter(Boolean).join(" ");
}

// Signature of a spawn's conditions (everything EXCEPT which form it is). Entries
// that share a signature are the same spawn and get merged.
function signature(e) {
  const s = (a) => (a || []).slice().sort();
  return JSON.stringify([s(e.b), s(e.st), s(e.px), e.r, e.lv, e.w, e.t || 0, s(e.wx), e.sky === undefined ? null : e.sky, e.pos || 0, s(e.bo)]);
}
// Merge a dex's entries by signature; label rows where only a subset of the
// species' forms spawn that way (regional/functional forms), drop the label
// when all forms — or the base form — spawn identically.
function mergeForms(entries) {
  const allForms = {};
  for (const e of entries) allForms[e.__form || ""] = 1;
  const totalForms = Object.keys(allForms).length;
  const groups = {}, order = [];
  for (const e of entries) {
    const sig = signature(e);
    if (!groups[sig]) { groups[sig] = { entry: e, forms: {} }; order.push(sig); }
    groups[sig].forms[e.__form || ""] = 1;
  }
  const out = [];
  for (const sig of order) {
    const g = groups[sig];
    const fk = Object.keys(g.forms);
    const hasBase = g.forms[""] === 1;
    let label = "";
    if (hasBase) label = "";                          // base form spawns here → standard
    else if (fk.length === totalForms) label = "";    // every form spawns identically → not distinguishing
    else if (fk.length > 3) label = "";               // big cosmetic swarm sharing one signature
    else label = fk.slice().sort().join(" / ");
    const e = g.entry;
    delete e.__form;
    if (label) e.f = label;
    out.push(e);
  }
  return out;
}

function uniq(arr) {
  const out = [], seen = {};
  for (const x of arr) if (x != null && !seen[x]) { seen[x] = 1; out.push(x); }
  return out;
}

// Structures / custom-spawn sites -> readable 🏛 labels (all of these exist:
// vanilla, cobblemon, and cobbleverse structures are all installed).
function siteLabel(ref) {
  const noHash = String(ref).replace(/^#/, "");
  const seg = noHash.replace(/^[a-z0-9_.-]+:/, "").split("/").pop();
  return readable(seg).replace(/\b\w/g, (c) => c.toUpperCase());
}

// Presets worth showing as 📍 context (skip the noise: natural/wild/water/etc.)
const PRESET_KEEP = {
  treetop: "treetop", urban: "urban", mansion: "mansion", trail_ruins: "trail ruins",
  jungle_pyramid: "jungle pyramid", desert_pyramid: "desert pyramid", ocean_ruins: "ocean ruins",
  ocean_monument: "ocean monument", pillager_outpost: "pillager outpost", ruined_portal: "ruined portal",
  stronghold: "stronghold", nether_fossil: "nether fossil", ancient_city: "ancient city",
  end_city: "end city", derelict: "derelict", lava: "lava", webs: "webs", redstone: "redstone",
  salt: "salt", saccharine_tree: "saccharine tree", foliage: "foliage",
};

// ---------- weight-multiplier / extra-condition notes ----------
function whenLabel(when) {
  if (when.weather) return when.weather.join("/");
  if (when.time) return when.time;
  if (when.moonPhase != null) return "moon " + when.moonPhase;
  if (when.fishing) return "lure " + (when.fishing.minLureLevel != null ? when.fishing.minLureLevel : 0);
  return null;
}
function notesOf(r) {
  const bo = [];
  if (r.y) {
    if (r.y.min != null && r.y.max != null) bo.push("Y " + r.y.min + "–" + r.y.max);
    else if (r.y.max != null) bo.push("Y≤" + r.y.max);
    else if (r.y.min != null) bo.push("Y≥" + r.y.min);
  }
  if (r.moonPhase != null) bo.push("moon " + r.moonPhase);
  if (r.slimeChunk === true) bo.push("slime chunk");
  if (r.nearbyBlocks) bo.push("near " + r.nearbyBlocks.map((b) => readable(b.replace(/^#?[a-z0-9_.-]+:/, ""))).join("/"));
  if (r.fishing) {
    const f = r.fishing, fb = [];
    if (f.rod) fb.push(f.rod + " rod");
    if (f.bait) fb.push("bait");
    if (fb.length) bo.push("🎣 " + fb.join(", "));
  }
  for (const m of r.multipliers || []) {
    const w = whenLabel(m.when);
    if (w && m.multiplier && m.multiplier !== 1) bo.push("×" + m.multiplier + " " + w);
  }
  return bo.length ? bo : null;
}

// ---------- build one compact entry from a research record ----------
function buildEntry(r) {
  const e = { b: uniq((r.biomes.include || []).map(biomeLabel)), r: r.rarity, lv: r.level, w: r.weight };
  const st = uniq((r.sites.include || []).map(siteLabel));
  const px = uniq((r.presets || []).map((p) => PRESET_KEEP[p]).filter(Boolean));
  if (r.time) e.t = r.time;
  if (r.weather) e.wx = r.weather;
  if (r.sky && r.sky.canSeeSky === true) e.sky = true;
  else if (r.sky && r.sky.canSeeSky === false) e.sky = false;
  if (r.position && r.position !== "grounded") e.pos = r.position;
  if (px.length) e.px = px;
  if (st.length) e.st = st;
  const bo = notesOf(r);
  if (bo) e.bo = bo;
  e.__form = formLabel(r.form);
  e._summonOnly = r.weight === 0;
  return e;
}

// ---------- carry over q (quest obtain) + raid from old spawns.json ----------
function oldMeta(oldData) {
  const q = {}, raid = {};
  for (const dex of Object.keys(oldData)) {
    for (const e of oldData[dex]) {
      if (e.q && !q[dex]) q[dex] = e.q;
      if (e.raid) raid[dex] = true;
    }
  }
  return { q: q, raid: raid };
}

function main() {
  const research = JSON.parse(fs.readFileSync(RESEARCH, "utf8")).species;
  const oldData = JSON.parse(fs.readFileSync(OLD, "utf8"));
  const meta = oldMeta(oldData);

  const out = {};
  const stats = { dex: 0, entries: 0, droppedForeignEntries: 0, biomeLabelsDropped: 0 };
  const droppedBiomeSet = {};

  for (const key of Object.keys(research)) {
    const sp = research[key];
    const dex = sp.dex != null ? String(sp.dex) : key;
    let entries = [];
    for (const r of sp.spawns) {
      // track which raw biome refs were dropped (for the report)
      for (const raw of r.biomes.include || []) {
        if (biomeLabel(raw) == null && !/not_spawn|^not spawn$/.test(norm(raw))) {
          droppedBiomeSet[norm(raw)] = (droppedBiomeSet[norm(raw)] || 0) + 1;
          stats.biomeLabelsDropped++;
        }
      }
      const e = buildEntry(r);
      // Drop an entry that was a wild spawn (weight>0) but whose only biomes
      // were foreign/non-existent and has no structure → unreachable here.
      if (!e.b.length && !(e.st && e.st.length) && e.w > 0) { stats.droppedForeignEntries++; continue; }
      entries.push(e);
    }

    // Merge entries that differ only by (cosmetic) form; label rows where a
    // subset of forms — e.g. Galarian, East Sea — spawns differently.
    entries = mergeForms(entries);

    // Attach carried-over quest + raid metadata.
    const q = meta.q[dex];
    const raid = meta.raid[dex];
    if (q) {
      let host = entries.filter((e) => e._summonOnly && e.st && e.st.length)[0] ||
                 entries.filter((e) => e._summonOnly)[0] ||
                 entries.filter((e) => e.st && e.st.length)[0] || entries[0];
      if (!host) { host = { b: [], r: "ultra-rare", lv: "", w: 0 }; entries.push(host); }
      host.q = q;
    }
    if (raid) {
      let host = entries.filter((e) => e.b && e.b.length)[0] || entries[0];
      if (!host) { host = { b: [], r: "ultra-rare", lv: "", w: 0 }; entries.push(host); }
      host.raid = true;
    }

    // strip helper flag and finalize
    const finalized = entries.map((e) => { delete e._summonOnly; return e; });
    if (!finalized.length) continue;
    out[dex] = finalized;
    stats.dex++;
    stats.entries += finalized.length;
  }

  // Carry over species that have NO datapack spawn file but DO have obtain
  // metadata in the old data (Raid-Den-only bosses / quest summons), e.g.
  // Melmetal, the fossil mons, Gholdengo. We only keep their non-biome obtain
  // info (raid/quest/summon) — never the old wiki biome guesses.
  for (const dex of Object.keys(oldData)) {
    if (out[dex]) continue;
    const carried = [];
    for (const e of oldData[dex]) {
      const noBiome = !e.b || !e.b.length;
      if (noBiome && (e.raid || e.q || e.w === 0)) {
        const k = { b: [], r: e.r || "ultra-rare", lv: e.lv || "", w: e.w || 0 };
        if (e.st) k.st = e.st;
        if (e.px) k.px = e.px;
        if (e.raid) k.raid = true;
        if (e.q) k.q = e.q;
        carried.push(k);
      }
    }
    if (carried.length) { out[dex] = carried; stats.dex++; stats.entries += carried.length; stats.carriedSpecies = (stats.carriedSpecies || 0) + 1; }
  }

  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log("Wrote", OUT);
  console.log("  species:", stats.dex, "entries:", stats.entries, "| carried raid/quest-only (no spawn file):", stats.carriedSpecies || 0);
  console.log("  dropped unreachable (foreign-biome-only) wild entries:", stats.droppedForeignEntries);
  console.log("  total foreign biome refs removed:", stats.biomeLabelsDropped);

  writeReport(oldData, out, stats, droppedBiomeSet);
}

function biomeUniverse(data) {
  const s = {};
  for (const dex of Object.keys(data)) for (const e of data[dex]) for (const b of e.b || []) s[b] = (s[b] || 0) + 1;
  return s;
}

function writeReport(oldData, newData, stats, droppedBiomeSet) {
  const oldB = biomeUniverse(oldData), newB = biomeUniverse(newData);
  const oldKeys = Object.keys(oldData), newKeys = Object.keys(newData);
  const lostSpecies = oldKeys.filter((k) => !newData[k]);
  const gainedSpecies = newKeys.filter((k) => !oldData[k]);
  const L = [];
  L.push("# Spawns: datapack vs. previous (wiki) data — comparison");
  L.push("");
  L.push("Regenerated `js/data/spawns.json` from the **real COBBLEVERSE-DP-v29 datapack** (was wiki-derived).");
  L.push("Biomes filtered to ones that **exist in this modpack** (vanilla only — no biome mods installed).");
  L.push("");
  L.push("## Totals");
  L.push("");
  L.push("| | Previous (wiki) | New (datapack) |");
  L.push("|--|--|--|");
  L.push("| species with data | " + oldKeys.length + " | " + newKeys.length + " |");
  L.push("| distinct biome labels | " + Object.keys(oldB).length + " | " + Object.keys(newB).length + " |");
  L.push("");
  L.push("- Foreign/non-existent biome refs removed: **" + stats.biomeLabelsDropped + "**");
  L.push("- Wild-spawn entries dropped as unreachable (foreign biome only): **" + stats.droppedForeignEntries + "**");
  L.push("");
  L.push("## Biome labels removed (existed in old data, gone now — not in this pack)");
  L.push("");
  const removedLabels = Object.keys(oldB).filter((b) => !newB[b]).sort();
  for (const b of removedLabels) L.push("- " + b + "  _(old uses: " + oldB[b] + ")_");
  L.push("");
  L.push("## Biome labels added (new from datapack)");
  L.push("");
  const addedLabels = Object.keys(newB).filter((b) => !oldB[b]).sort();
  for (const b of addedLabels) L.push("- " + b + "  _(new uses: " + newB[b] + ")_");
  L.push("");
  L.push("## Foreign biome refs dropped (raw → count of spawn conditions)");
  L.push("");
  const dk = Object.keys(droppedBiomeSet).sort((a, b) => droppedBiomeSet[b] - droppedBiomeSet[a]);
  for (const k of dk) L.push("- `" + k + "` × " + droppedBiomeSet[k]);
  L.push("");
  L.push("## Species coverage change");
  L.push("");
  L.push("- In old but **not** in new (no reachable spawn/summon now): **" + lostSpecies.length + "** → " + (lostSpecies.length ? lostSpecies.join(", ") : "none"));
  L.push("- In new but not in old: **" + gainedSpecies.length + "** → " + (gainedSpecies.length ? gainedSpecies.join(", ") : "none"));
  fs.writeFileSync(REPORT, L.join("\n"));
  console.log("Wrote", REPORT);
}

main();
