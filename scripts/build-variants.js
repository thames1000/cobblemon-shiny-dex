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
// Sort cosmetic forms within a species alphabetically, but keep non-letter
// names (Unown's "!" and "?") after Z instead of before A (where ASCII puts them).
function cosmeticNameKey(name) {
  return (/^[a-z]/i.test(name) ? "0" : "1") + String(name).toLowerCase();
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

/* The `cobblemon` group (Cobblemon-original model variants) is built separately
 * by scripts/build-cobblemon-variants.js from the Cobblemon Wiki, which is the
 * only source with artwork for them. We preserve whatever's already in
 * variants.json so rerunning THIS script (for regional/cosmetic) doesn't wipe it. */
function existingCobblemon(dest) {
  try { return JSON.parse(fs.readFileSync(dest, "utf8")).cobblemon || []; }
  catch (_) { return []; }
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
  out.cosmetic.sort((a, b) => a.dex - b.dex || cosmeticNameKey(a.name).localeCompare(cosmeticNameKey(b.name)));

  const dest = path.join(__dirname, "..", "js", "data", "variants.json");
  out.cobblemon = existingCobblemon(dest); // owned by build-cobblemon-variants.js
  fs.writeFileSync(dest, JSON.stringify(out));
  const r = out.regional;
  console.log(`Wrote -> ${dest}`);
  console.log(`  regional: alolan ${r.alolan.length}, galarian ${r.galarian.length}, hisuian ${r.hisuian.length}, paldean ${r.paldean.length}`);
  console.log(`  cosmetic: ${out.cosmetic.length}`);
  console.log(`  cobblemon: ${out.cobblemon.length} (preserved; rebuild via build-cobblemon-variants.js)`);
}

main();
