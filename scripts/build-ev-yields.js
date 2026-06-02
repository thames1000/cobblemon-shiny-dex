/* Merge EV-yield data into js/data/species.json (adds an `ev` array of the
 * stats each species yields effort in). Used by the PokéSnack builder so EV
 * Bait Seasonings (Pomeg, Kelpsy, …) can re-rank attraction like type berries.
 *
 * Unlike types/egg-groups, PokeAPI has no per-EV endpoint, so this fetches
 * /pokemon/N for every species (concurrency-limited). Reads the existing
 * species.json and only adds the field, leaving everything else unchanged.
 *
 * Runs on plain Node (no deps). Re-run when the pack updates Cobblemon.
 *   node scripts/build-ev-yields.js
 */
const https = require("https");
const fs = require("fs");
const path = require("path");

const API = "https://pokeapi.co/api/v2";
const CONCURRENCY = 10;

// PokeAPI stat slug -> name used in js/data/berries.json `ev` field.
const STAT_NAME = {
  hp: "HP", attack: "Attack", defense: "Defense",
  "special-attack": "Sp. Atk", "special-defense": "Sp. Def", speed: "Speed",
};

function getJSON(url, tries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        if (left > 0) return setTimeout(() => attempt(left - 1), 400);
        return reject(new Error(`${res.statusCode} ${url}`));
      }
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on("error", (e) => (left > 0 ? setTimeout(() => attempt(left - 1), 400) : reject(e)));
    attempt(tries);
  });
}

async function main() {
  const dest = path.join(__dirname, "..", "js", "data", "species.json");
  const species = JSON.parse(fs.readFileSync(dest, "utf8"));

  console.log(`Fetching EV yields for ${species.length} species (concurrency ${CONCURRENCY})...`);
  let done = 0;
  const queue = species.slice();
  async function worker() {
    let s;
    while ((s = queue.shift())) {
      const data = await getJSON(`${API}/pokemon/${s.dex}`);
      s.ev = (data.stats || []).filter((st) => st.effort > 0)
        .map((st) => STAT_NAME[st.stat.name]).filter(Boolean);
      if (++done % 100 === 0) process.stdout.write(`  ${done} `);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log();

  const missing = species.filter((s) => !s.ev || !s.ev.length).map((s) => s.dex);
  if (missing.length) console.warn(`Note: ${missing.length} species yield no EVs (e.g. some forms): ${missing.slice(0, 20).join(",")}...`);

  fs.writeFileSync(dest, JSON.stringify(species));
  console.log(`Merged EV yields into ${species.length} species -> ${dest}`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
