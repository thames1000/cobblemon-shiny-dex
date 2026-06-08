/* Build js/data/variants.json from a Cobblemon `species` data directory.
 *
 * Regional forms (Alolan / Galarian / Hisuian / Paldean) and cosmetic variants
 * (Pikachu caps, Vivillon patterns, Unown letters, …) are defined as `forms`
 * with `aspects` on each species JSON. Mega / Gigantamax / Primal are tracked
 * separately (forms.json), so they're excluded here.
 *
 * COBBLEVERSE retunes and ADDS variants (e.g. Magikarp / Torterra / Gyarados
 * patterns) that base Cobblemon doesn't have. Point this at the datapack's
 * species dir to capture them:
 *
 *   unzip -oq COBBLEVERSE-DP-v<N>-CF.zip "data/cobblemon/species/**" -d /tmp/cv
 *   node scripts/build-variants.js /tmp/cv/data/cobblemon/species
 *
 * Falls back to base Cobblemon (sparse clone) if no path is given:
 *   git clone --filter=blob:none --no-checkout --depth 1 \
 *     https://gitlab.com/cable-mc/cobblemon.git /tmp/cobblemon
 *   cd /tmp/cobblemon && git sparse-checkout init --cone
 *   git sparse-checkout set common/src/main/resources/data/cobblemon/species
 *   git checkout
 *   node scripts/build-variants.js /tmp/cobblemon/common/src/main/resources/data/cobblemon/species
 *
 * Output: { regional: { alolan:[e], galarian:[e], hisuian:[e], paldean:[e] },
 *           cosmetic: [e] }  where each e = { id, dex, base, name, aspects }.
 */
const fs = require("fs");
const path = require("path");

const SRC = process.argv[2] ||
  "/tmp/cobblemon/common/src/main/resources/data/cobblemon/species";

const REGION_LABEL = {
  alolan_form: "alolan", galarian_form: "galarian",
  hisuian_form: "hisuian", paldean_form: "paldean",
};
// Tracked elsewhere (forms.json) or transient battle states, not collectible
// appearances — exclude so the tracker only lists things you can actually catch.
// Matched as substrings of a form's aspects/name (e.g. "galarian-zen").
const SKIP = ["mega", "gmax", "primal", "totem", "zen", "blade", "busted",
  "gulping", "gorging", "hangry", "noice", "school", "pirouette",
  "battle-bond", "crowned"];
const isSkipped = (form) =>
  SKIP.some((k) => `${(form.aspects || []).join(" ")} ${form.name || ""} ${(form.labels || []).join(" ")}`.toLowerCase().includes(k));

function titleCase(s) {
  return String(s).replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}
// Pokémon Showdown sprite slug: strip accents + punctuation, lowercase.
// (Cobblemon form names line up with Showdown's, e.g. "Pa'u" -> "pau".)
function slugify(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}

function walk(dir, out, nameToDex) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) { walk(p, out, nameToDex); continue; }
    if (!f.endsWith(".json")) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { continue; }
    const dex = j.nationalPokedexNumber;
    const base = titleCase(j.name || f.replace(/\.json$/, ""));
    if (dex && j.name) nameToDex[j.name.toLowerCase()] = dex;
    if (!dex) continue;
    for (const form of j.forms || []) {
      const labels = form.labels || [];
      const aspects = (form.aspects || []).filter(Boolean);
      if (isSkipped(form)) continue;
      const region = labels.map((l) => REGION_LABEL[l]).find(Boolean);
      const id = `${j.name}-${(aspects.join("-") || form.name || "form").toLowerCase()}`;
      const slug = `${slugify(base)}-${slugify(form.name || aspects[0] || "")}`.replace(/-$/, "");
      const entry = { id, dex, base, name: titleCase(form.name || aspects[0] || "Form"), aspects, slug };
      if (region) (out.regional[region] = out.regional[region] || []).push(entry);
      else out.cosmetic.push(entry);
    }
  }
}

/* Cobblemon-exclusive cosmetic variants live in species_features (choice aspects)
 * assigned via species_feature_assignments — NOT in the species `forms` array.
 * These are texture-only patterns Cobblemon adds (Magikarp/Gyarados Jump, Arbok
 * snake patterns, Torterra-line tree types, etc.). Allowlisted so battle/mechanic
 * features (mega, stance, schooling…) are excluded. No external sprite exists for
 * them, so they render on the base sprite with the pattern as the label. */
const COBBLEMON_FEATURES = new Set([
  "magikarp_jump", "snake_pattern", "tree", "mooshtank", "league_cap",
  "color", "metals", "netherite_coating", "gilded_chest", "gyarados_eye_color",
]);
const GENERIC_CHOICE = new Set(["", "none", "standard", "normal", "natural", "default"]);

function readJsonDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (_) { return null; }
  }).filter(Boolean);
}

function buildCobblemon(speciesDir, nameToDex) {
  const defs = {};
  for (const d of readJsonDir(path.join(speciesDir, "..", "species_features"))) {
    if (d.type !== "choice" || !Array.isArray(d.choices)) continue;
    for (const k of (d.keys || [])) defs[k] = d;
  }
  const out = [], seen = new Set();
  for (const a of readJsonDir(path.join(speciesDir, "..", "species_feature_assignments"))) {
    for (const feat of (a.features || [])) {
      if (!COBBLEMON_FEATURES.has(feat)) continue;
      const def = defs[feat];
      if (!def) continue;
      const fmt = def.aspectFormat || "{{choice}}";
      for (const mon of (a.pokemon || [])) {
        const dex = nameToDex[String(mon).toLowerCase()];
        if (!dex) continue;
        for (const choice of def.choices) {
          if (choice === def.default || GENERIC_CHOICE.has(String(choice).toLowerCase())) continue;
          const aspect = fmt.replace("{{choice}}", choice);
          const id = `${mon}-${aspect}`;
          if (seen.has(id)) continue;
          seen.add(id);
          // Pikachu's Ash caps are mainline (Showdown has them); the rest are
          // Cobblemon-original textures with no external sprite -> base sprite.
          const slug = feat === "league_cap" ? `${slugify(mon)}-${slugify(choice)}` : "";
          out.push({ id, dex, base: titleCase(mon), name: titleCase(choice), aspects: [aspect], slug });
        }
      }
    }
  }
  return out.sort((a, b) => a.dex - b.dex || a.name.localeCompare(b.name));
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`Source dir not found: ${SRC}\nSee header comment for how to get the species dir.`);
    process.exit(1);
  }
  const out = { regional: { alolan: [], galarian: [], hisuian: [], paldean: [] }, cosmetic: [], cobblemon: [] };
  const nameToDex = {};
  walk(SRC, out, nameToDex);
  for (const k of Object.keys(out.regional)) out.regional[k].sort((a, b) => a.dex - b.dex);
  out.cosmetic.sort((a, b) => a.dex - b.dex);
  out.cobblemon = buildCobblemon(SRC, nameToDex);

  const dest = path.join(__dirname, "..", "js", "data", "variants.json");
  fs.writeFileSync(dest, JSON.stringify(out));
  const r = out.regional;
  console.log(`Wrote -> ${dest}`);
  console.log(`  regional: alolan ${r.alolan.length}, galarian ${r.galarian.length}, hisuian ${r.hisuian.length}, paldean ${r.paldean.length}`);
  console.log(`  cosmetic: ${out.cosmetic.length}`);
  console.log(`  cobblemon: ${out.cobblemon.length}`);
}

main();
