/* Build js/data/moves.json — a slim move list for the Party Builder's move
 * pickers and the type-biased random generator.
 *
 * Source: Pokémon Showdown's full move dex (one request). We keep only the
 * fields the UI needs (name, type, category) and drop Z-moves, Max moves and
 * CAP (fan-made) moves. Learnsets are intentionally NOT bundled — the full
 * learnsets file is ~3 MB; move choice here is free (not legality-checked).
 *
 *   node scripts/build-moves.js
 *
 * Output: [ { name, type, category } ] sorted by name.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const SRC = "https://play.pokemonshowdown.com/data/moves.json";

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(b)); }).on("error", reject);
  });
}

async function main() {
  const dex = JSON.parse(await get(SRC));
  const out = [];
  for (const id of Object.keys(dex)) {
    const m = dex[id];
    if (!m || !m.name || !m.type || !m.category) continue;
    if (m.isZ || m.isMax) continue;            // not real moveslot moves
    if (m.isNonstandard === "CAP") continue;   // fan-made
    out.push({ name: m.name, type: m.type, category: m.category });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  const dest = path.join(__dirname, "..", "js", "data", "moves.json");
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log(`Wrote ${out.length} moves -> ${dest} (${(fs.statSync(dest).size / 1024).toFixed(1)} KB)`);
  const byCat = (c) => out.filter((m) => m.category === c).length;
  console.log(`  Physical ${byCat("Physical")}, Special ${byCat("Special")}, Status ${byCat("Status")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
