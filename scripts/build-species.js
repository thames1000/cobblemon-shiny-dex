/* Build js/data/species.json — the bundled reference roster for all 1025
 * National Dex Pokemon (dex #, name, types, generation).
 *
 * Strategy (efficient): one /pokemon?limit=1025 call for the ordered name list,
 * then 18 /type/N calls to map every species to its type(s). That's ~19 requests
 * instead of 1025. Filters out alternate-form ids (>10000) and dex > 1025.
 *
 * Runs on plain Node (no deps, uses https). Re-run when the pack updates Cobblemon.
 *   node scripts/build-species.js
 */
const https = require("https");
const fs = require("fs");
const path = require("path");

const API = "https://pokeapi.co/api/v2";
const MAX_DEX = 1025;

// National Dex generation boundaries (by dex number).
const GEN_RANGES = [
  [1, 1, 151], [2, 152, 251], [3, 252, 386], [4, 387, 493], [5, 494, 649],
  [6, 650, 721], [7, 722, 809], [8, 810, 905], [9, 906, 1025],
];
function genFor(dex) {
  const g = GEN_RANGES.find(([, lo, hi]) => dex >= lo && dex <= hi);
  return g ? g[0] : null;
}

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

// Pull the trailing integer id out of a PokeAPI resource url.
function idFromUrl(url) {
  const m = url.match(/\/(\d+)\/?$/);
  return m ? Number(m[1]) : null;
}

async function main() {
  console.log("Fetching ordered species list...");
  const list = await getJSON(`${API}/pokemon?limit=${MAX_DEX}`);
  const species = {}; // dex -> { dex, name, types, gen }
  for (const item of list.results) {
    const dex = idFromUrl(item.url);
    if (dex && dex <= MAX_DEX) {
      species[dex] = { dex, name: item.name, types: [], gen: genFor(dex) };
    }
  }

  console.log("Fetching type membership (18 types)...");
  const typeList = await getJSON(`${API}/type`);
  const realTypes = typeList.results.filter((t) => !["unknown", "shadow", "stellar"].includes(t.name));
  for (const t of realTypes) {
    const data = await getJSON(t.url);
    for (const p of data.pokemon) {
      const dex = idFromUrl(p.pokemon.url);
      if (dex && species[dex] && !species[dex].types.includes(t.name)) {
        species[dex].types.push(t.name);
      }
    }
    process.stdout.write(`  ${t.name} `);
  }
  console.log();

  const out = Object.values(species).sort((a, b) => a.dex - b.dex);
  const missing = out.filter((s) => s.types.length === 0).map((s) => s.dex);
  if (missing.length) console.warn(`WARN: ${missing.length} species without types: ${missing.slice(0, 20).join(",")}...`);

  const dest = path.join(__dirname, "..", "js", "data", "species.json");
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log(`Wrote ${out.length} species -> ${dest}`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
