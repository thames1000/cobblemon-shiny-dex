/**
 * Enrich js/data/spawns.json with sky/block light-level conditions pulled from
 * the real datapack extract (research/cobbleverse-spawns-v29.json).
 *
 * The datapack-derived build dropped the spawn light window (minSkyLight /
 * maxSkyLight / maxLight), keeping only the canSeeSky boolean. Light level is a
 * force-spawn lever independent of time (e.g. "sky light ≤7" = spawns in a dark
 * cave at any hour), so we add a compact note into each entry's `bo` list.
 *
 * A full rebuild isn't reproducible here (the Cobblemon biome-tag dir is gone),
 * so this patches the committed spawns.json IN PLACE. Records are matched to
 * entries per-dex on biome-independent fields (rarity/level/position/time/
 * weather). When records sharing a signature disagree on the light note, the
 * match is ambiguous and skipped — we never add a note we're unsure about.
 *
 *   node scripts/enrich-spawns-light.js [--write]
 */
const fs = require("fs");
const path = require("path");

const RESEARCH = path.join(__dirname, "..", "research", "cobbleverse-spawns-v29.json");
const SPAWNS = path.join(__dirname, "..", "js", "data", "spawns.json");
const WRITE = process.argv.includes("--write");

// Compact, force-spawn-oriented light note. Returns null for the default
// "needs normal daylight" window (sky 8–15) to avoid bloating ~1,300 entries.
function lightNote(sky) {
  if (!sky) return null;
  const lo = sky.minSkyLight, hi = sky.maxSkyLight, ml = sky.maxLight;
  const out = [];
  if (hi != null && hi < 15) {
    out.push(lo != null && lo > 0 ? `light ${lo}-${hi}` : `light ≤${hi}`);
  }
  if (ml != null && ml < 15) out.push(`block light ≤${ml}`);
  return out.length ? out.join(" ") : null; // becomes one or more `bo` tokens
}

// Signature shared by a raw research record and a built spawns.json entry,
// excluding biome. The canSeeSky boolean is included because it's a key thing
// that separates an otherwise identical dark-cave spawn from its surface twin.
const sig = (rarity, level, pos, time, weather, sky) =>
  [rarity, level, pos || "grounded", time || "", (weather || []).slice().sort().join("/"),
    sky === true ? "S" : sky === false ? "s" : "-"].join("|");

function recSig(r) {
  const sky = r.sky && r.sky.canSeeSky === true ? true : r.sky && r.sky.canSeeSky === false ? false : undefined;
  return sig(r.rarity, r.level, r.position, r.time, r.weather, sky);
}
function entrySig(e) { return sig(e.r, e.lv, e.pos, e.t, e.wx, e.sky); }

// Reproduce the build's biome label WITHOUT the tag dir. Only the existence
// filter (foreign-biome drop) needs the tags; the label is pure string work.
// Foreign biomes map to themselves and simply won't overlap spawns.json's `b`.
const readable = (s) => String(s).replace(/_/g, " ").trim();
function norm(ref) { return (/^is_/.test(ref) || /^nether\/is_/.test(ref)) ? "#cobblemon:" + ref : ref; }
function biomeLabel(rawRef) {
  const ref = norm(rawRef);
  if (/not_spawn|^not spawn$/.test(ref)) return null;
  const tag = ref.match(/^#?([a-z0-9_.-]+):(.+)$/);
  if (!tag) return readable(ref);
  const ns = tag[1], body = tag[2];
  if (ref[0] !== "#") return ns === "minecraft" ? readable(body) : null;
  if (body === "is_overworld") return "any overworld";
  if (body === "has_block/mud") return "mangrove swamp";
  const neth = body.match(/^nether\/is_(.+)$/);
  if (neth) return "nether " + readable(neth[1]);
  return readable(body.replace(/^is_/, ""));
}
const recLabels = (r) => new Set((r.biomes.include || []).map(biomeLabel).filter(Boolean));

function main() {
  const research = JSON.parse(fs.readFileSync(RESEARCH, "utf8")).species;
  const spawns = JSON.parse(fs.readFileSync(SPAWNS, "utf8"));

  // dex -> [ { sig, labels:Set, note } ] for every raw spawn record.
  const byDex = {};
  for (const key of Object.keys(research)) {
    const sp = research[key];
    const dex = sp.dex != null ? String(sp.dex) : key;
    (byDex[dex] = byDex[dex] || []).push(
      ...sp.spawns.map((r) => ({ sig: recSig(r), labels: recLabels(r), note: lightNote(r.sky) }))
    );
  }

  const stats = { added: 0, alreadyHad: 0, ambiguous: 0, noNote: 0, noMatch: 0 };
  const samples = [];
  for (const dex of Object.keys(spawns)) {
    const recs = byDex[dex];
    for (const e of spawns[dex]) {
      if (!recs) { stats.noMatch++; continue; }
      const es = entrySig(e);
      const eb = e.b || [];
      // Match on signature AND (when the entry has biomes) biome-label overlap.
      const matched = recs.filter((r) =>
        r.sig === es && (!eb.length || !r.labels.size || eb.some((b) => r.labels.has(b))));
      if (!matched.length) { stats.noMatch++; continue; }
      const notes = [...new Set(matched.map((r) => r.note))];
      if (notes.length > 1) { stats.ambiguous++; continue; } // still disagree -> unsafe
      const note = notes[0];
      if (!note) { stats.noNote++; continue; }
      if (e.bo && e.bo.some((n) => /(^|\s)(light [\d≤]|block light)/.test(n))) { stats.alreadyHad++; continue; } // idempotent (avoid matching "lightning rod")
      e.bo = e.bo || [];
      e.bo.push(note);
      stats.added++;
      if (samples.length < 14) samples.push(`#${dex} ${e.r} ${e.lv} ${e.pos || "grounded"} [${eb.join(",")}] -> ${note}`);
    }
  }

  console.log(WRITE ? "WROTE changes:" : "DRY RUN (pass --write to apply):");
  console.log("  light notes added:", stats.added);
  console.log("  already had a light note:", stats.alreadyHad);
  console.log("  matched but no constraint (default 8–15):", stats.noNote);
  console.log("  ambiguous (skipped):", stats.ambiguous);
  console.log("  no matching research record:", stats.noMatch);
  console.log("  samples:\n   " + samples.join("\n   "));

  if (WRITE) {
    fs.writeFileSync(SPAWNS, JSON.stringify(spawns));
    console.log("Wrote", SPAWNS);
  }
}
main();
