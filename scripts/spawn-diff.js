/* spawn-diff.js — easiest way to verify the datapack re-sync of js/data/spawns.json.
 *
 * Shows the PREVIOUS (wiki) data vs the NEW (datapack) data, in plain English.
 *
 *   node scripts/spawn-diff.js pikachu      # one species, old vs new, side by side
 *   node scripts/spawn-diff.js 144          # by dex number
 *   node scripts/spawn-diff.js --removed    # every species that LOST a biome that
 *                                           #   doesn't exist in this pack (the cull)
 *   node scripts/spawn-diff.js --summary    # headline counts
 *
 * Baseline: research/spawns-prev-wiki.json (snapshot of the old data).
 * Current:  js/data/spawns.json.
 */
const fs = require("fs");
const path = require("path");

const NEW = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "js", "data", "spawns.json"), "utf8"));
const OLD = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "research", "spawns-prev-wiki.json"), "utf8"));
let SPECIES = [];
try { SPECIES = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "js", "data", "species.json"), "utf8")); } catch (e) {}
const nameByDex = {};
for (const s of SPECIES) nameByDex[s.dex] = s.name;

// Labels that exist in the NEW (datapack, existence-filtered) data — the set of
// biomes that are actually reachable in this modpack.
const REAL = {};
for (const k of Object.keys(NEW)) for (const e of NEW[k]) for (const b of e.b || []) REAL[b] = 1;

// Known cosmetic relabels (old wiki label -> new datapack label) so the
// "--removed" view doesn't flag a rename as a removal.
const RELABEL = {
  "arid / desert": "arid", "any biome": "any overworld", "any nether": "nether",
  "has block — mud": "mangrove swamp", "the end": "end",
  "nether — basalt deltas": "nether basalt", "nether — crimson forest": "nether crimson",
  "nether — desert": "nether desert", "nether — fungus": "nether fungus",
  "nether — mountain": "nether mountain", "nether — soul fire": "nether soul fire",
  "nether — soul sand": "nether soul sand", "nether — warped forest": "nether warped",
  "nether — wasteland": "nether wasteland",
};
function normOld(b) { return RELABEL[b] || b; }

function fmt(e) {
  const p = [];
  if (e.f) p.push("[" + e.f + "]");
  p.push(e.r + " Lv" + (e.lv || "?") + " w" + e.w);
  if (e.b && e.b.length) p.push("in " + e.b.join(", "));
  if (e.st && e.st.length) p.push("@ " + e.st.join(", "));
  if (e.px && e.px.length) p.push("[" + e.px.join(", ") + "]");
  if (e.t) p.push("🕘" + e.t);
  if (e.wx) p.push("🌧" + e.wx.join("/"));
  if (e.sky === true) p.push("needs sky");
  if (e.sky === false) p.push("underground");
  if (e.pos) p.push(e.pos);
  if (e.bo) p.push(e.bo.join(" "));
  if (e.raid) p.push("⚔ RAID");
  if (e.q) p.push("🧩 quest:" + (e.q.item || e.q.radar || "summon"));
  return p.join(" · ");
}

function showOne(dex) {
  const nm = nameByDex[dex] || ("#" + dex);
  const o = OLD[String(dex)], n = NEW[String(dex)];
  console.log("\n#" + dex + "  " + nm);
  console.log("  OLD (wiki):");
  if (!o) console.log("     (none)"); else o.forEach((e) => console.log("     - " + fmt(e)));
  console.log("  NEW (datapack):");
  if (!n) console.log("     (none — no reachable spawn/summon)"); else n.forEach((e) => console.log("     + " + fmt(e)));
  // biome delta
  const ob = [].concat.apply([], (o || []).map((e) => e.b || [])).map(normOld);
  const nb = [].concat.apply([], (n || []).map((e) => e.b || []));
  const removed = ob.filter((b) => nb.indexOf(b) < 0 && !REAL[b]);
  if (removed.length) console.log("  ⤷ removed biomes (don't exist here): " + [...new Set(removed)].join(", "));
}

function removedReport() {
  let count = 0;
  for (const k of Object.keys(OLD)) {
    const o = OLD[k], n = NEW[k] || [];
    const ob = [...new Set([].concat.apply([], o.map((e) => e.b || [])).map(normOld))];
    const nb = new Set([].concat.apply([], n.map((e) => e.b || [])));
    const removed = ob.filter((b) => !nb.has(b) && !REAL[b]);
    if (removed.length) {
      count++;
      console.log("#" + String(k).padStart(4, "0") + " " + (nameByDex[k] || "") + "  removed: " + removed.join(", "));
    }
  }
  console.log("\n" + count + " species had a non-existent biome removed.");
}

function summary() {
  const ok = Object.keys(OLD), nk = Object.keys(NEW);
  const ob = new Set(), nb = new Set();
  for (const k of ok) for (const e of OLD[k]) for (const b of e.b || []) ob.add(b);
  for (const k of nk) for (const e of NEW[k]) for (const b of e.b || []) nb.add(b);
  console.log("species:        old " + ok.length + "  ->  new " + nk.length);
  console.log("biome labels:   old " + ob.size + "  ->  new " + nb.size);
  console.log("lost species:   " + ok.filter((k) => !NEW[k]).join(", "));
}

const arg = process.argv[2];
if (!arg) { console.log("usage: node scripts/spawn-diff.js <name|dex> | --removed | --summary"); process.exit(0); }
if (arg === "--removed") removedReport();
else if (arg === "--summary") summary();
else if (/^\d+$/.test(arg)) showOne(parseInt(arg, 10));
else {
  const q = arg.toLowerCase();
  const hits = SPECIES.filter((s) => s.name === q).concat(SPECIES.filter((s) => s.name.indexOf(q) === 0 && s.name !== q));
  if (!hits.length) { console.log("no species matching '" + arg + "'"); process.exit(1); }
  hits.slice(0, 5).forEach((s) => showOne(s.dex));
}
