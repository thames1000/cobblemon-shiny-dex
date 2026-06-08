/* Rebuild the `cobblemon` group of js/data/variants.json from the Cobblemon
 * Wiki's "Unique Forms" page.
 *
 * These are Cobblemon-ORIGINAL model variants (Magikarp / Gyarados Jump
 * patterns, Arbok snake patterns, Torterra-line tree types, Gholdengo
 * netherite, Mooshtank, Vivillon/Valencia cosmetics, …). Unlike mainline
 * forms they have no PokeAPI / Showdown sprite, but the wiki hosts a "(Model)"
 * render AND a "Shiny (Model)" render for each — so we pull both.
 *
 * The wiki uses MediaWiki, so we don't need the MD5-hashed /images/ path:
 * Special:FilePath/<Filename> redirects to the real file. We just need the
 * exact filenames, which we read from the page's image list via the API.
 *
 *   node scripts/build-cobblemon-variants.js
 *
 * Region forms (Alolan/Galarian/Hisuian/Paldean) on that page are skipped —
 * they live in the `regional` group already. national-dex name -> dex comes
 * from js/data/species.json, so no Cobblemon species checkout is needed.
 *
 * Each entry: { id, dex, base, name, wikiFile, wikiFileShiny }.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const API = "https://wiki.cobblemon.com/api.php?action=query&prop=images" +
  "&titles=Pok%C3%A9mon/Unique_Forms&imlimit=500&format=json";
const FILEPATH = (file) =>
  "https://wiki.cobblemon.com/index.php/Special:FilePath/" +
  encodeURIComponent(file.replace(/ /g, "_"));

const REGION = new Set(["alolan", "galarian", "hisuian", "paldean"]);
// Wiki names that don't match a national-dex species (Cobblemon's own name).
const ALIAS = { mooshtank: "miltank" };

function titleCase(s) {
  return String(s).replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

async function main() {
  const root = path.join(__dirname, "..");
  const species = JSON.parse(fs.readFileSync(path.join(root, "js/data/species.json"), "utf8"));
  const nameToDex = {};
  for (const s of species) nameToDex[s.name.toLowerCase()] = s.dex;

  const json = JSON.parse(await get(API));
  const pages = json.query.pages;
  const page = pages[Object.keys(pages)[0]];
  const files = (page.images || []).map((i) => i.title.replace(/^File:/, ""));
  const fileSet = new Set(files);

  const out = [];
  const seen = new Set();
  const skipped = [];
  for (const file of files) {
    if (/shiny/i.test(file)) continue; // pull shiny via its paired model file
    const m = file.match(/^(.*?)\s*\((model)\)\.png$/i);
    if (!m) { skipped.push(file); continue; }
    const tag = m[2]; // preserve "Model" / "model" casing for the shiny filename
    const words = m[1].trim().split(/\s+/);

    // The species is whichever word matches a national-dex name; the rest is
    // the pattern. ("Oak Torterra" -> base Torterra, pattern Oak.)
    let baseIdx = words.findIndex((w) => {
      const k = w.toLowerCase();
      return nameToDex[k] !== undefined || ALIAS[k] !== undefined;
    });
    if (baseIdx < 0) { skipped.push(file); continue; }
    const baseWord = words[baseIdx];
    const pattern = words.filter((_, i) => i !== baseIdx);
    if (pattern.some((p) => REGION.has(p.toLowerCase()))) continue; // -> regional group

    const baseKey = baseWord.toLowerCase();
    const dex = nameToDex[ALIAS[baseKey] || baseKey];
    const base = titleCase(ALIAS[baseKey] ? ALIAS[baseKey] : baseWord);
    const name = titleCase(pattern.join(" ")) || "Form";
    const shinyFile = file.replace(/\s*\((model)\)\.png$/i, ` Shiny (${tag}).png`);
    const id = `cob-${baseKey}-${pattern.join("-").toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id, dex, base, name,
      wikiFile: file,
      wikiFileShiny: fileSet.has(shinyFile) ? shinyFile : null,
    });
  }
  out.sort((a, b) => a.dex - b.dex || a.name.localeCompare(b.name));

  const dest = path.join(root, "js/data/variants.json");
  const variants = JSON.parse(fs.readFileSync(dest, "utf8"));
  variants.cobblemon = out;
  fs.writeFileSync(dest, JSON.stringify(variants));

  console.log(`Wrote ${out.length} cobblemon variants -> ${dest}`);
  console.log(`  with shiny art: ${out.filter((e) => e.wikiFileShiny).length}/${out.length}`);
  if (skipped.length) console.log(`  skipped (unmapped): ${skipped.join(", ")}`);
  // Resolve URL example for sanity.
  if (out[0]) console.log(`  e.g. ${out[0].base} ${out[0].name} -> ${FILEPATH(out[0].wikiFile)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
