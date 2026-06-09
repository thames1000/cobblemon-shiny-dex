/* Build js/data/spawns.json from the Cobbleverse community wiki's per-species
 * pages (cazuike/cobbleverse-wiki), which are generated from the CURRENT
 * COBBLEVERSE datapack (v29 at time of writing) — newer than the raw v19
 * datapack the old build-spawns.js parsed.
 *
 * Why the wiki and not the datapack: the wiki's "## How to obtain" section
 * already resolves each spawn's biome tags into readable category headers
 * (e.g. "Ocean", "Arid / Desert"), flags Raid Den bosses, and — crucially —
 * documents how legendaries / mythicals are actually obtained in Cobbleverse:
 * they are NOT wild spawns but QUEST-GATED SUMMONS (craft a radar → use a
 * gating item at a named structure, after a trainer prerequisite). The old
 * data showed them as plain wild "site" spawns, which is wrong.
 *
 * Usage:
 *   # markdown already downloaded to a dir of <dex>-<name>.md files:
 *   node scripts/build-spawns-wiki.js /tmp/cvmd/files
 *   # (to refresh: fetch docs/pokemon/*.md from the cazuike/cobbleverse-wiki repo)
 *
 * Output shape (compact, back-compatible with the Spawns tab) —
 *   { "<dex>": [ { b:[biomes], r:rarity, lv:level, w:weight, t:time|null,
 *     wx:[weather]|null, sky:bool|null, pos:positionType, px:null, st:[sites]|null,
 *     bo:[notes]|null, raid:true?, q:{item,where,prereq,radar,region}? } ] }
 *
 *   b  = readable biome categories (chips + reverse biome lookup)
 *   st = named summon structure for a quest-gated legendary (🏛 chip)
 *   q  = quest info for a legendary/mythical (gating item, radar, prerequisite)
 *   raid = species is also a Cobblemon Raid Den boss
 */
const fs = require("fs");
const path = require("path");

const SRC = process.argv[2] || "/tmp/cvmd/files";
const OUT = process.argv[3] || path.join(__dirname, "..", "js", "data", "spawns.json");

const RARITIES = new Set(["common", "uncommon", "rare", "ultra-rare"]);
function mapRarity(r) {
  const k = String(r || "").toLowerCase().trim().replace(/\s+/g, "-");
  return RARITIES.has(k) ? k : "rare";
}
function push(arr, v) { (arr = arr || []).push(v); return arr; }
function cleanLabel(s) {
  return String(s).replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

// Lines of the "## How to obtain" section only.
function howToObtain(md) {
  const lines = md.split(/\r?\n/);
  let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) if (/^## How to obtain/.test(lines[i])) { start = i + 1; break; }
  if (start < 0) return [];
  for (let i = start; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break; }
  return lines.slice(start, end);
}

// Split into top-level MkDocs admonition blocks: a line `!!! type "title"` opens
// a block; indented lines are its body; a column-0 `<small>`/other line closes it.
function adBlocks(lines) {
  const out = [];
  let cur = null;
  for (const ln of lines) {
    const m = ln.match(/^!!! (\w+) "(.*)"\s*$/);
    if (m) { cur = { type: m[1], title: m[2], body: [] }; out.push(cur); continue; }
    if (!cur) continue;
    if (/^\S/.test(ln)) { cur = null; continue; } // unindented line ends the block
    cur.body.push(ln);
  }
  return out;
}

// "daylight only, raining, near water" -> time / weather / leftover note.
function applyConditions(e, cond) {
  if (!cond) return;
  if (/daylight only/.test(cond)) e.t = "day";
  else if (/dark only/.test(cond)) e.t = "night";
  const wx = [];
  if (/thunderstorm/.test(cond)) wx.push("thunder");
  else if (/raining/.test(cond)) wx.push("rain");
  if (/clear weather/.test(cond)) wx.push("clear");
  if (wx.length) e.wx = wx;
  // Whatever's left after stripping time/weather = block/height anchors ("near
  // water", "Y≤0", …). Keep it as a single compact note rather than mis-splitting
  // multi-item "near a, b, c" lists on their commas.
  let rest = cond
    .replace(/daylight only|dark only|clear weather|thunderstorm|raining/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .trim();
  if (rest) e.bo = push(e.bo, rest);
}

function parseWild(b) {
  const header = b.title.replace(/^Wild spawn · /, "").trim();
  let lv = "", r = "rare", w = 0, cond = "";
  for (const ln of b.body) {
    const m = ln.match(/\*\*Level ([^*]+)\*\* · bucket `([^`]+)` · weight `([^`]+)`(?: · \*([^*]+)\*)?/);
    if (m) { lv = m[1].trim(); r = m[2]; w = parseFloat(m[3]) || 0; cond = (m[4] || "").trim(); break; }
  }
  const e = { b: [], r: mapRarity(r), lv: lv, w: w, pos: "grounded", t: null, wx: null, sky: null, px: null, st: null, bo: null };
  const cm = header.match(/^Custom Spawn(?: — (.+))?$/);
  if (cm) { if (cm[1]) e.st = [cleanLabel(cm[1])]; /* else: bare summon, no named structure */ }
  else if (/^any biome$/i.test(header) || /^Any Overworld$/i.test(header)) e.b = [header.toLowerCase()];
  else e.b = header.split(/,\s*/).map((s) => s.toLowerCase().trim()).filter(Boolean);
  applyConditions(e, cond);
  return e;
}

function firstFlavor(body, skipRe) {
  for (const ln of body) {
    const m = ln.match(/^\s*\*([^*].*?)\*\s*$/);
    if (m && !(skipRe && skipRe.test(m[1]))) return m[1].trim();
  }
  return null;
}
function parseExample(b) {
  const text = b.body.join("\n");
  const q = {};
  const im = text.match(/using \*\*([^*]+)\*\* \(`([^`]+)`\)/);
  if (im) q.item = im[1].trim();
  const where = firstFlavor(b.body, /Prerequisite/);
  if (where) q.where = where;
  const pm = text.match(/\*\*Prerequisite:\*\* complete advancement \*([^*]+)\*/);
  if (pm) q.prereq = pm[1].trim();
  const rg = b.title.match(/·\s*(.+)$/);
  if (rg) q.region = rg[1].trim();
  return q;
}
function parseTracker(b) {
  const text = b.body.join("\n");
  const rm = text.match(/Craft \*\*([^*]+)\*\* \(`([^`]+)`\)/);
  if (!rm) return null;
  return { radar: rm[1].trim(), flavor: firstFlavor(b.body, /Recipe/) };
}

// The cazuike pages name a legendary's summon structure but rarely the biome it
// generates in. These come from the Cobbleverse Fandom "Legendary location"
// page (the structure's host biome) — useful for actually finding the altar.
const STRUCT_BIOME = {
  382: "Deep Cold Ocean",        // Kyogre
  383: "Warm Ocean",             // Groudon
  386: "The End",                // Deoxys
  480: "Glacial Chasm",          // Uxie — Lake Acuity
  481: "Sakura Valley",          // Mesprit — Lake Verity
  482: "Arid Highlands",         // Azelf — Lake Valor
  485: "Nether Wastes (Stark Mountain)", // Heatran
};

function parseSpecies(md, dex) {
  const blocks = adBlocks(howToObtain(md));
  const wilds = [];
  const examples = [];
  const radars = [];
  let raid = false;
  for (const bl of blocks) {
    if (bl.type === "info" && /^Wild spawn/.test(bl.title)) {
      const e = parseWild(bl);
      // Skip Cobblemon's "not spawn" disable placeholder (e.g. Pikachu, which
      // only comes from Pichu) — it's a real biome-less weight-0 marker, not a spawn.
      if (e.b.length === 1 && e.b[0] === "not spawn") continue;
      wilds.push(e);
    } else if (bl.type === "abstract" && /Raid den boss/i.test(bl.title)) raid = true;
    else if (bl.type === "example" && /Special obtain/i.test(bl.title)) examples.push(parseExample(bl));
    else if (bl.type === "note" && /^Tracker/.test(bl.title)) { const r = parseTracker(bl); if (r) radars.push(r); }
  }

  // Assemble the quest object (legendary / mythical summon). Some legendaries
  // (e.g. the Legendary Beasts) ship only a tracker radar, no catch advancement.
  let q = null;
  const radarNames = radars.map((r) => r.radar).join(" + ");
  if (examples.length) {
    q = examples[0];
    if (radarNames) q.radar = radarNames;
  } else if (radars.length) {
    q = { radar: radarNames };
    if (radars[0].flavor) q.where = radars[0].flavor;
  }
  if (q && STRUCT_BIOME[dex]) q.biome = STRUCT_BIOME[dex];

  const entries = wilds;
  // Attach the quest to the summon entry (weight-0 Custom Spawn) if present,
  // otherwise to the first entry, otherwise create a placeholder so the
  // legendary still shows up with its catch method.
  if (q) {
    let host = entries.find((e) => e.st && e.w === 0) || entries.find((e) => e.st) || entries[0];
    if (!host) { host = { b: [], r: "ultra-rare", lv: "", w: 0, pos: "grounded", t: null, wx: null, sky: null, px: null, st: null, bo: null }; entries.push(host); }
    host.q = q;
  }
  // Raid Den boss: nearly every species is one, so only surface it when it's a
  // *primary* obtain method — i.e. the species has no real (weight>0) wild spawn.
  // Otherwise it's just noise next to the actual spawn.
  if (raid) {
    const hasWild = entries.some((e) => e.w > 0 && (e.b.length || e.st));
    if (!hasWild) {
      if (entries.length) entries[0].raid = true;
      else entries.push({ b: [], r: "ultra-rare", lv: "", w: 0, pos: "grounded", t: null, wx: null, sky: null, px: null, st: null, bo: null, raid: true });
    }
  }
  return entries;
}

function main() {
  const files = fs.readdirSync(SRC).filter((f) => /^\d+-.*\.md$/.test(f));
  const out = {};
  let withSpawn = 0, withQuest = 0, withRaid = 0;
  for (const f of files) {
    const dex = parseInt(f.slice(0, f.indexOf("-")), 10);
    if (!Number.isFinite(dex)) continue;
    const entries = parseSpecies(fs.readFileSync(path.join(SRC, f), "utf8"), dex);
    if (!entries.length) continue;
    out[dex] = entries;
    withSpawn++;
    if (entries.some((e) => e.q)) withQuest++;
    if (entries.some((e) => e.raid)) withRaid++;
  }
  // Compact JSON: drop null/empty optional fields to keep the file lean.
  for (const dex of Object.keys(out)) {
    out[dex] = out[dex].map((e) => {
      const o = { b: e.b, r: e.r, lv: e.lv, w: e.w };
      if (e.pos && e.pos !== "grounded") o.pos = e.pos;
      if (e.t) o.t = e.t;
      if (e.wx) o.wx = e.wx;
      if (e.sky != null) o.sky = e.sky;
      if (e.px) o.px = e.px;
      if (e.st) o.st = e.st;
      if (e.bo) o.bo = e.bo;
      if (e.raid) o.raid = true;
      if (e.q) o.q = e.q;
      return o;
    });
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
  const total = Object.keys(out).length;
  console.log(`Wrote ${OUT}`);
  console.log(`  species with spawn/obtain data: ${total}`);
  console.log(`  quest-gated (legendary/mythical): ${withQuest}`);
  console.log(`  raid den bosses: ${withRaid}`);
}
main();
