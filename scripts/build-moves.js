/* Build js/data/moves.json — the move list for the Party Builder pickers, the
 * type-biased random generator and the Coach.
 *
 * Source: Pokémon Showdown's move dex + learnsets. We keep only moves that at
 * least one Pokémon can actually learn — this drops Struggle (no learnset) and
 * any other non-obtainable entry — plus Z/Max/CAP moves. Per-species legality
 * lives in coach.json (build-coach.js); this file is the global pool.
 *
 *   node scripts/build-moves.js
 *
 * Output: [ { name, type, category, power, acc } ] sorted by name (acc: 100 = never-miss).
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const MOVES_URL = "https://play.pokemonshowdown.com/data/moves.json";
const LEARN_URL = "https://play.pokemonshowdown.com/data/learnsets.json";

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(b)); }).on("error", reject);
  });
}

async function main() {
  const [dex, learn] = await Promise.all([get(MOVES_URL).then(JSON.parse), get(LEARN_URL).then(JSON.parse)]);

  // Every move id any species can learn (so Struggle and the like are excluded).
  const learnable = new Set();
  for (const id of Object.keys(learn)) {
    const ls = learn[id].learnset;
    if (ls) for (const mv of Object.keys(ls)) learnable.add(mv);
  }

  const out = [];
  let dropped = 0;
  for (const id of Object.keys(dex)) {
    const m = dex[id];
    if (!m || !m.name || !m.type || !m.category) continue;
    if (m.isZ || m.isMax || m.isNonstandard === "CAP") continue;
    if (!learnable.has(id)) { dropped++; continue; } // not in any learnset (e.g. Struggle)
    out.push({ name: m.name, type: m.type, category: m.category, power: m.basePower || 0, acc: m.accuracy === true ? 100 : (m.accuracy || 100) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));

  const dest = path.join(__dirname, "..", "js", "data", "moves.json");
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log(`Wrote ${out.length} moves -> ${dest} (${(fs.statSync(dest).size / 1024).toFixed(1)} KB)`);
  console.log(`  dropped ${dropped} unlearnable/non-standard (Struggle excluded: ${!out.some((m) => m.name === "Struggle")})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
