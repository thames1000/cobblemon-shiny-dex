/* Build js/data/coach.json — per-species data the Party Builder's Coach and the
 * legal-move pickers need: base stats, abilities and the move pool.
 *
 * Sources (Pokémon Showdown, one request each): pokedex.json (base stats,
 * abilities, types) and learnsets.json (move pools). Keyed by NATIONAL DEX
 * number, taken from js/data/species.json so it lines up with the rest of the app.
 *
 *   node scripts/build-coach.js
 *
 * Output: { "<dex>": { base:{hp,atk,def,spa,spd,spe}, bst, abilities:[…], moves:[displayName…] } }
 * Move pools are standard (Cobblemon datapacks may tweak them); they exist to
 * keep pickers/coach sane, not to enforce exact legality.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const DEX_URL = "https://play.pokemonshowdown.com/data/pokedex.json";
const MOVES_URL = "https://play.pokemonshowdown.com/data/moves.json";
const LEARN_URL = "https://play.pokemonshowdown.com/data/learnsets.json";
const FORMATS_URL = "https://play.pokemonshowdown.com/data/formats-data.js"; // Smogon SV tiers
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
// Pokédex tags that count as "legendary" for the random generator.
const LEGEND_TAGS = new Set(["Sub-Legendary", "Restricted Legendary", "Mythical"]);

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(b)); }).on("error", reject);
  });
}
// Showdown's learnset for a species can defer to its prevo ("Charizard" learns
// most via "Charmeleon"). Walk the prevo chain and union all the moves.
function collectMoves(id, dex, learn, seen) {
  seen = seen || new Set();
  if (!id || seen.has(id)) return [];
  seen.add(id);
  const out = [];
  const ls = learn[id] && learn[id].learnset;
  if (ls) out.push(...Object.keys(ls));
  const entry = dex[id];
  if (entry && entry.prevo) out.push(...collectMoves(slug(entry.prevo), dex, learn, seen));
  if (entry && entry.baseSpecies && slug(entry.baseSpecies) !== id) out.push(...collectMoves(slug(entry.baseSpecies), dex, learn, seen));
  return out;
}

async function main() {
  const species = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "js", "data", "species.json"), "utf8"));
  const [dex, moveDex, learn, formatsJs] = await Promise.all([
    get(DEX_URL).then(JSON.parse), get(MOVES_URL).then(JSON.parse), get(LEARN_URL).then(JSON.parse), get(FORMATS_URL),
  ]);
  const fexp = {}; (new Function("exports", formatsJs))(fexp); // exports.BattleFormatsData = {...}
  const formats = fexp.BattleFormatsData || {};
  const tierOf = (id) => String((formats[id] && formats[id].tier) || "").replace(/[()]/g, ""); // strip "(OU)" parens
  const moveName = {};                       // move id -> display name
  for (const id of Object.keys(moveDex)) moveName[id] = moveDex[id].name;
  const byNum = {};                          // national dex num -> base-form ps id
  for (const id of Object.keys(dex)) {
    const e = dex[id];
    if (e.num > 0 && (!e.forme || e.baseSpecies === undefined) && byNum[e.num] === undefined) byNum[e.num] = id;
  }

  const out = {};
  let noStats = 0, noMoves = 0;
  for (const sp of species) {
    const id = dex[slug(sp.name)] ? slug(sp.name) : byNum[sp.dex];
    const e = id && dex[id];
    if (!e || !e.baseStats) { noStats++; continue; }
    const b = e.baseStats;
    const base = { hp: b.hp, atk: b.atk, def: b.def, spa: b.spa, spd: b.spd, spe: b.spe };
    const bst = base.hp + base.atk + base.def + base.spa + base.spd + base.spe;
    const ab = e.abilities || {};
    const abilities = Object.values(ab);
    const hidden = ab.H || "";   // hidden ability (often the competitive pick)
    const moveIds = [...new Set(collectMoves(id, dex, learn))];
    const moves = moveIds.map((m) => moveName[m]).filter(Boolean).sort();
    if (!moves.length) noMoves++;
    const tier = tierOf(id);                                   // SV singles tier (e.g. OU, UU, Uber)
    const leg = (e.tags || []).some((t) => LEGEND_TAGS.has(t)); // legendary / mythical
    out[sp.dex] = { base, bst, abilities, hidden, moves, tier, leg };
  }

  const dest = path.join(__dirname, "..", "js", "data", "coach.json");
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log(`Wrote ${Object.keys(out).length} species -> ${dest} (${(fs.statSync(dest).size / 1024).toFixed(0)} KB)`);
  if (noStats) console.log(`  ! ${noStats} species had no Showdown stats (skipped)`);
  if (noMoves) console.log(`  ! ${noMoves} species had no move pool`);
  // Verify category membership (the random generator uses OU = OU+UUBL, UU = UU+RUBL).
  const v = Object.values(out);
  const inOU = (t) => t === "OU" || t === "UUBL";
  const inUU = (t) => t === "UU" || t === "RUBL";
  console.log(`  OU pool: ${v.filter((x) => inOU(x.tier)).length}, UU pool: ${v.filter((x) => inUU(x.tier)).length}, legendaries: ${v.filter((x) => x.leg).length}`);
  const mc = out[572];
  console.log(`  Minccino: BST ${mc.bst}, tier ${mc.tier || "—"}, ${mc.moves.length} moves`);
}

main().catch((e) => { console.error(e); process.exit(1); });
