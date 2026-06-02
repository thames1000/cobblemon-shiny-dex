/* Merge egg-group membership into js/data/species.json (adds an `eggGroups`
 * array to each species). Used by the PokéSnack builder so egg-group Bait
 * Seasonings (Lum, Pecha, Cheri, …) can re-rank attraction like type berries.
 *
 * Strategy (efficient): one /egg-group/N call per group (~15 requests) listing
 * its species, instead of one call per Pokemon. Reads the existing species.json
 * and only adds the field, so types/gen stay byte-for-byte unchanged.
 *
 * Runs on plain Node (no deps). Re-run when the pack updates Cobblemon.
 *   node scripts/build-egg-groups.js
 */
const https = require("https");
const fs = require("fs");
const path = require("path");

const API = "https://pokeapi.co/api/v2";

// PokeAPI egg-group slug -> name used in js/data/berries.json.
const GROUP_NAME = {
  monster: "Monster", water1: "Water 1", water2: "Water 2", water3: "Water 3",
  bug: "Bug", flying: "Flying", ground: "Field", fairy: "Fairy", plant: "Grass",
  humanshape: "Human-Like", mineral: "Mineral", indeterminate: "Amorphous",
  ditto: "Ditto", dragon: "Dragon", "no-eggs": "No Eggs",
};

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`${res.statusCode} ${url}`)); res.resume(); return; }
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}
function idFromUrl(url) { const m = url.match(/\/(\d+)\/?$/); return m ? Number(m[1]) : null; }

async function main() {
  const dest = path.join(__dirname, "..", "js", "data", "species.json");
  const species = JSON.parse(fs.readFileSync(dest, "utf8"));
  const byDex = {};
  species.forEach((s) => { s.eggGroups = []; byDex[s.dex] = s; });

  console.log("Fetching egg-group membership (~15 groups)...");
  const list = await getJSON(`${API}/egg-group?limit=50`);
  for (const g of list.results) {
    const name = GROUP_NAME[g.name] || g.name;
    const data = await getJSON(g.url);
    for (const p of data.pokemon_species) {
      const dex = idFromUrl(p.url);
      if (dex && byDex[dex] && !byDex[dex].eggGroups.includes(name)) byDex[dex].eggGroups.push(name);
    }
    process.stdout.write(`  ${name} (${data.pokemon_species.length}) `);
  }
  console.log();

  const missing = species.filter((s) => !s.eggGroups.length).map((s) => s.dex);
  if (missing.length) console.warn(`WARN: ${missing.length} species without egg groups: ${missing.slice(0, 20).join(",")}...`);

  fs.writeFileSync(dest, JSON.stringify(species));
  console.log(`Merged egg groups into ${species.length} species -> ${dest}`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
