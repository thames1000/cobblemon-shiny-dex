/**
 * Build research/cobblemon-hitboxes.json — per-species spawn hitbox (width ×
 * height in blocks) used to enrich cobbleverse-spawns.csv. The hitbox sets how
 * much clear space a spot needs for the Pokémon to spawn, so it's a force-spawn
 * factor (e.g. Alolan Exeggutor is 11 blocks tall and won't spawn in a low cave).
 *
 * Sources (re-download these to /tmp before re-running):
 *   - Base Cobblemon species (each *.json has a top-level "hitbox"):
 *       curl -L "https://gitlab.com/cable-mc/cobblemon/-/archive/main/cobblemon-main.tar.gz?path=common/src/main/resources/data/cobblemon/species" -o /tmp/cob_species.tar.gz
 *       mkdir -p /tmp/cobspecies && tar -xzf /tmp/cob_species.tar.gz -C /tmp/cobspecies
 *   - Cobbleverse datapack species_additions (override "hitbox" by "target"):
 *       find /tmp/cvdp -path "*species_additions*" -name "*.json"
 *   - Default when a species omits hitbox: EntityDimensions.fixed(1,1) per
 *     Cobblemon Species.kt -> width 1, height 1, fixed true.
 *
 *   node scripts/build-hitboxes.js
 */
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const SPECIES = path.join(__dirname, "..", "js", "data", "species.json");
const OUT = path.join(__dirname, "..", "research", "cobblemon-hitboxes.json");
const DEFAULT = { w: 1, h: 1, fixed: true, src: "default" };

const sh = (c) => cp.execSync(c, { maxBuffer: 1 << 28 }).toString().trim();
// Map regional demonyms to the species form stem (the species JSON names forms
// "Alola"/"Galar"/…, while spawn data uses "alolan"/"galarian"/…). Must stay in
// sync with normForm() in build-cobbleverse-spawns-csv.js.
const REGION_ALIAS = { alolan: "alola", galarian: "galar", hisuian: "hisui", paldean: "paldea", kantonian: "kanto", unovan: "unova", valencian: "valencia" };
const norm = (s) => { s = String(s).toLowerCase().trim(); return REGION_ALIAS[s] || s; };

function main() {
  const dexByName = {};
  JSON.parse(fs.readFileSync(SPECIES, "utf8")).forEach((s) => (dexByName[s.name.toLowerCase()] = s.dex));

  const byDex = {};      // dex -> {name,w,h,fixed,src}
  const forms = {};      // dex -> [{form(normalized), w,h,fixed}] for forms whose hitbox differs

  // 1) base Cobblemon species
  const baseFiles = sh('find /tmp/cobspecies -name "*.json"').split("\n").filter(Boolean);
  for (const f of baseFiles) {
    let j; try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { continue; }
    const dex = j.nationalPokedexNumber;
    if (!dex) continue;
    if (j.hitbox) byDex[dex] = { name: j.name, w: j.hitbox.width, h: j.hitbox.height, fixed: !!j.hitbox.fixed, src: "base" };
    for (const fm of j.forms || []) {
      if (fm.hitbox && j.hitbox && (fm.hitbox.width !== j.hitbox.width || fm.hitbox.height !== j.hitbox.height)) {
        (forms[dex] = forms[dex] || []).push({ form: norm(fm.name), w: fm.hitbox.width, h: fm.hitbox.height, fixed: !!fm.hitbox.fixed });
      }
    }
  }

  // 2) Cobbleverse species_additions overrides (rescales many mons)
  let overrides = 0;
  let addFiles = [];
  try { addFiles = sh('find /tmp/cvdp -path "*species_additions*" -name "*.json"').split("\n").filter(Boolean); } catch (e) {}
  for (const f of addFiles) {
    let j; try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { continue; }
    if (!j.hitbox || !j.target) continue;
    const dex = dexByName[String(j.target).replace(/^.*:/, "").toLowerCase()];
    if (!dex) continue;
    byDex[dex] = { name: (byDex[dex] && byDex[dex].name) || String(j.target).replace(/^.*:/, ""),
      w: j.hitbox.width, h: j.hitbox.height, fixed: !!j.hitbox.fixed, src: "cobbleverse" };
    overrides++;
  }

  // 3) default fallback for every species in our roster that still lacks a hitbox
  let defaulted = 0;
  Object.values(JSON.parse(fs.readFileSync(SPECIES, "utf8"))).forEach((s) => {
    if (!byDex[s.dex]) { byDex[s.dex] = Object.assign({ name: s.name }, DEFAULT); defaulted++; }
  });

  fs.writeFileSync(OUT, JSON.stringify({ byDex, forms }));
  const counts = { base: 0, cobbleverse: 0, default: 0 };
  Object.values(byDex).forEach((h) => counts[h.src]++);
  console.log("Wrote", OUT);
  console.log("  species:", Object.keys(byDex).length, "| base:", counts.base, "cobbleverse-override:", counts.cobbleverse, "default(1x1):", counts.default);
  console.log("  divergent-form hitboxes:", Object.values(forms).reduce((a, x) => a + x.length, 0), "across", Object.keys(forms).length, "species");
}
main();
