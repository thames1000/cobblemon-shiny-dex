/* Build js/data/berry-guide.json — every Cobblemon berry and how to obtain it.
 *
 * Source: the Cobblemon Wiki "Berry Tree" page (raw wikitext), which holds two
 * tables: natural berries with their biome spawn tags + preferred mulch, and
 * the mutation chart (parent1 + parent2 -> mutated berry + mulch). We parse both
 * and merge in a hand-kept effect blurb per berry.
 *
 *   node scripts/build-berry-guide.js
 *
 * Output: [ { id, name, kind, source, biomes, mulch, effect } ] sorted natural
 * first (by spawn), then drop, then mutations.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const WIKITEXT = "https://wiki.cobblemon.com/index.php?title=Berry_Tree&action=raw";

// One-line effect per berry (from the wiki Berry page). Keyed by lower-case name.
const EFFECT = {
  oran: "Restores 10 HP", cheri: "Cures paralysis", chesto: "Cures sleep",
  pecha: "Cures poison", rawst: "Cures burn", aspear: "Cures freeze",
  persim: "Cures confusion", razz: "Bait / flavor berry", bluk: "Bait / flavor berry",
  nanab: "Bait / flavor berry", wepear: "Bait / flavor berry", pinap: "Bait / flavor berry",
  occa: "Weakens a super-effective Fire hit", passho: "Weakens a super-effective Water hit",
  wacan: "Weakens a super-effective Electric hit", rindo: "Weakens a super-effective Grass hit",
  yache: "Weakens a super-effective Ice hit", chople: "Weakens a super-effective Fighting hit",
  kebia: "Weakens a super-effective Poison hit", shuca: "Weakens a super-effective Ground hit",
  coba: "Weakens a super-effective Flying hit", payapa: "Weakens a super-effective Psychic hit",
  tanga: "Weakens a super-effective Bug hit", charti: "Weakens a super-effective Rock hit",
  kasib: "Weakens a super-effective Ghost hit", haban: "Weakens a super-effective Dragon hit",
  colbur: "Weakens a super-effective Dark hit", babiri: "Weakens a super-effective Steel hit",
  chilan: "Weakens any Normal hit", roseli: "Weakens a super-effective Fairy hit",
  leppa: "Restores 10 PP to a depleted move", lum: "Cures any status + confusion",
  hopo: "Restores PP outside battle", figy: "Restores ⅓ HP (may confuse — spicy)",
  wiki: "Restores ⅓ HP (may confuse — dry)", mago: "Restores ⅓ HP (may confuse — sweet)",
  aguav: "Restores ⅓ HP (may confuse — bitter)", iapapa: "Restores ⅓ HP (may confuse — sour)",
  sitrus: "Restores ¼ HP at ½ HP", touga: "Cures confusion", cornn: "Pokéblock / flavor berry",
  magost: "Pokéblock / flavor berry", rabuta: "Pokéblock / flavor berry", nomel: "Pokéblock / flavor berry",
  spelon: "Pokéblock / flavor berry", pamtre: "Pokéblock / flavor berry", watmel: "Pokéblock / flavor berry",
  durin: "Pokéblock / flavor berry", belue: "Pokéblock / flavor berry",
  enigma: "Restores ¼ HP after a super-effective hit", kee: "+1 Defense after a physical hit",
  maranga: "+1 Sp. Def after a special hit", pomeg: "−10 HP EVs, +friendship",
  kelpsy: "−10 Attack EVs, +friendship", qualot: "−10 Defense EVs, +friendship",
  hondew: "−10 Sp. Atk EVs, +friendship", grepa: "−10 Sp. Def EVs, +friendship",
  tamato: "−10 Speed EVs, +friendship", liechi: "+1 Attack at low HP", ganlon: "+1 Defense at low HP",
  petaya: "+1 Sp. Atk at low HP", apicot: "+1 Sp. Def at low HP", salac: "+1 Speed at low HP",
  starf: "+2 to a random stat at low HP", lansat: "+1 crit ratio at low HP",
  micle: "Boosts accuracy of next move at low HP", custap: "Move first in priority bracket at low HP",
  jaboca: "Physical attacker loses ⅛ HP", rowap: "Special attacker loses ⅛ HP",
  eggant: "Cures infatuation",
};
// Berries that aren't from a tree (overrides the table parse).
const SPECIAL_SOURCE = { hopo: "Pokémon drops" };

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(b)); }).on("error", reject);
  });
}
// "Oran {{ScaledImage|Oran Berry.png|32px}}" -> "Oran"; "''Jungle''" -> "Jungle".
function clean(s) {
  return String(s).replace(/\{\{[^}]*\}\}/g, "").replace(/\[\[[^\]|]*\|?([^\]]*)\]\]/g, "$1")
    .replace(/'''?/g, "").replace(/<[^>]+>/g, "").trim();
}
// Split one wikitable into logical rows; each row is the list of its cell lines
// (the text after the leading | or !), with any rowspan="N" noted.
function tableRows(block) {
  const rows = [];
  let cur = null;
  for (const raw of block.split("\n")) {
    const line = raw.trimEnd();
    if (/^\|-/.test(line)) { if (cur) rows.push(cur); cur = []; continue; }
    if (cur === null) continue;
    if (/^[|!]/.test(line)) {
      // a line may pack several cells with "||"; headers ("!") we skip as data
      const isHeader = line[0] === "!";
      const body = line.replace(/^[|!]\s?/, "");
      for (const part of body.split(/\|\|/)) {
        const m = part.match(/rowspan\s*=\s*"?(\d+)"?/i);
        const span = m ? Number(m[1]) : 1;
        // strip an optional leading "attributes |" segment (colspan/rowspan/style…),
        // being careful NOT to cut on the pipes inside {{ScaledImage|…}}.
        let content = part;
        const attr = part.match(/^\s*(?:rowspan|colspan|class|style|align|scope|width|height)\b[^|{]*\|/i);
        if (attr) content = part.slice(attr[0].length);
        cur.push({ text: clean(content), span, header: isHeader, italic: /''/.test(content) });
      }
    }
  }
  if (cur) rows.push(cur);
  return rows;
}
// Rebuild a row grid honoring rowspan carry-over across rows.
function gridify(rows) {
  const grid = [], carry = [];
  for (const cells of rows) {
    const out = [];
    let ci = 0;
    for (let col = 0; out.length < 40 && (ci < cells.length || carry[col]); col++) {
      if (carry[col] && carry[col].left > 0) { out.push(carry[col].val); carry[col].left--; continue; }
      if (ci >= cells.length) break;
      const c = cells[ci++];
      out.push(c.text);
      if (c.span > 1) carry[col] = { val: c.text, left: c.span - 1 };
    }
    grid.push(out);
  }
  return grid;
}
function section(text, startMarker) {
  const i = text.indexOf(startMarker);
  const open = text.lastIndexOf("{|", i); // the table opener precedes the marker
  const close = text.indexOf("\n|}", open);
  return text.slice(open, close);
}

async function main() {
  const wt = await get(WIKITEXT);

  // --- Natural berries: name | biome cells (italic) ... | mulch | yield | bonus
  const natural = [];
  for (const cells of tableRows(section(wt, "Biome spawn tag"))) {
    if (!cells.length || cells[0].header) continue;
    const name = cells[0].text;
    if (!name || !EFFECT[name.toLowerCase()]) continue;
    // Biome cells are italic (''Jungle''); the mulch cell is plain text. This
    // matters because "Sandy" is both a biome and a mulch name.
    const restCells = cells.slice(1).filter((c) => c.text !== "" && c.text !== "+");
    const MULCH = /(Loamy|Coarse|Peat|Humid|Sandy)/;
    const biomeList = restCells.filter((c) => c.italic).map((c) => c.text);
    const mulchCell = restCells.find((c) => !c.italic && MULCH.test(c.text));
    const mulch = mulchCell ? mulchCell.text : "";
    natural.push({
      id: name.toLowerCase(), name: `${name} Berry`,
      kind: SPECIAL_SOURCE[name.toLowerCase()] ? "drop" : "natural",
      biomes: [...new Set(biomeList)],
      mulch, source: "", effect: EFFECT[name.toLowerCase()] || "",
    });
  }

  // --- Mutation chart: parent1 | + | parent2 | -> | mutated | mulch | ...
  // Some berries are "parent1 + one of {…}", with the alternates listed on the
  // following rowspan'd rows (all carrying the same mutated berry), so group by
  // the mutated berry and collect every distinct second parent.
  const mutMap = {};
  const mgrid = gridify(tableRows(section(wt, "class=\"wikitable\"\n! colspan=\"3\" |Parent Berries")));
  for (const row of mgrid) {
    const cols = row.filter((t) => t !== "+" && t !== "→");
    const [p1, p2, mutated, mulch] = cols; // parent1, parent2, mutated, mulch, …
    const key = (mutated || "").toLowerCase();
    if (!mutated || !EFFECT[key]) continue;
    const m = mutMap[key] || (mutMap[key] = { p1, mulch: (mulch || "").match(/(Loamy|Coarse|Peat|Humid|Sandy)/) ? mulch : "", parents: [] });
    if (p2 && !/one of the following/i.test(p2) && !m.parents.includes(p2)) m.parents.push(p2);
  }
  const mutation = Object.keys(mutMap).map((key) => {
    const m = mutMap[key];
    const second = m.parents.length > 1 ? `(${m.parents.join(" / ")})` : (m.parents[0] || "?");
    return {
      id: key, name: `${key[0].toUpperCase()}${key.slice(1)} Berry`, kind: "mutation",
      biomes: [], mulch: m.mulch, source: `${m.p1} + ${second}`, effect: EFFECT[key],
    };
  });

  // Merge, de-dupe (prefer the richer entry), apply special sources.
  const byId = {};
  for (const b of [...natural, ...mutation]) {
    if (SPECIAL_SOURCE[b.id]) { b.kind = "drop"; b.source = SPECIAL_SOURCE[b.id]; }
    if (!byId[b.id]) byId[b.id] = b;
  }
  const order = { natural: 0, drop: 1, mutation: 2 };
  const all = Object.values(byId).sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  for (const b of all) b.img = `${b.name}.png`; // wiki item sprite (via Special:FilePath)

  const dest = path.join(__dirname, "..", "js", "data", "berry-guide.json");
  fs.writeFileSync(dest, JSON.stringify(all));
  const n = (k) => all.filter((b) => b.kind === k).length;
  console.log(`Wrote ${all.length} berries -> ${dest}`);
  console.log(`  natural ${n("natural")}, drop ${n("drop")}, mutation ${n("mutation")}`);
  const missingEffect = all.filter((b) => !b.effect).map((b) => b.id);
  const missingHow = all.filter((b) => b.kind === "natural" && !b.biomes.length).map((b) => b.id);
  const badMut = all.filter((b) => b.kind === "mutation" && !/ \+ \S/.test(b.source)).map((b) => b.id);
  if (missingEffect.length) console.log(`  ! no effect: ${missingEffect.join(", ")}`);
  if (missingHow.length) console.log(`  ! no biome: ${missingHow.join(", ")}`);
  if (badMut.length) console.log(`  ! bad recipe: ${badMut.join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
