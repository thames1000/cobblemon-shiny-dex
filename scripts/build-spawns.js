/* Build js/data/spawns.json from Cobblemon's spawn_pool_world JSON.
 *
 * Get the source once (sparse partial clone keeps it light):
 *   git clone --filter=blob:none --no-checkout --depth 1 \
 *     https://gitlab.com/cable-mc/cobblemon.git /tmp/cobblemon-spawns
 *   cd /tmp/cobblemon-spawns && git sparse-checkout init --cone
 *   git sparse-checkout set common/src/main/resources/data/cobblemon/spawn_pool_world
 *   git checkout
 *
 * Then:  node scripts/build-spawns.js [path-to-spawn_pool_world]
 *
 * Output shape (compact): { "<dex>": [ { b:[biomes], r:rarity, lv:level, w:weight,
 *   pos:positionType, t:timeRange|null, wx:[weather]|null, sky:canSeeSky|null,
 *   px:[presetContext]|null } ] }
 */
const fs = require("fs");
const path = require("path");

const SRC = process.argv[2] ||
  "/tmp/cobblemon-spawns/common/src/main/resources/data/cobblemon/spawn_pool_world";

// Presets that describe a meaningful spawn *context* worth showing the player.
const CONTEXT_PRESETS = new Set([
  "ancient_city", "desert_pyramid", "jungle_pyramid", "end_city", "ocean_monument",
  "ocean_ruins", "pillager_outpost", "ruined_portal", "stronghold", "trail_ruins",
  "nether_fossil", "mansion", "lava", "water", "webs", "treetop", "urban",
  "redstone", "salt", "saccharine_tree", "derelict",
]);

function cleanBiome(tag) {
  // Strip leading '#', any 'namespace:' prefix, and an 'is_' tag marker.
  return String(tag)
    .replace(/^#/, "")
    .replace(/^[a-z0-9_.-]+:/, "")
    .replace(/^is_/, "")
    .replace(/_/g, " ")
    .trim();
}
function weatherOf(cond) {
  const w = [];
  if (cond.isThundering === true) w.push("thunder");
  else if (cond.isRaining === true) w.push("rain");
  if (cond.isRaining === false) w.push("clear");
  return w.length ? w : null;
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`Source dir not found: ${SRC}\nSee header comment for the sparse-clone command.`);
    process.exit(1);
  }
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".json"));
  const out = {};
  let entryCount = 0;

  for (const file of files) {
    const m = file.match(/^(\d+)_/);
    if (!m) continue;
    const dex = Number(m[1]);
    if (dex < 1 || dex > 1025) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(SRC, file), "utf8")); }
    catch (_) { continue; }
    if (!data.enabled || !Array.isArray(data.spawns)) continue;

    const rows = [];
    for (const sp of data.spawns) {
      if (sp.type && sp.type !== "pokemon") continue;
      const c = sp.condition || {};
      const biomes = (c.biomes || []).map(cleanBiome);
      const presets = (sp.presets || []).filter((p) => CONTEXT_PRESETS.has(p));
      const row = {
        b: biomes,
        r: sp.bucket || "common",
        lv: sp.level || null,
        w: sp.weight != null ? sp.weight : null,
        pos: sp.spawnablePositionType || null,
        t: c.timeRange || null,
        wx: weatherOf(c),
        sky: c.canSeeSky === undefined ? null : c.canSeeSky,
        px: presets.length ? presets : null,
      };
      rows.push(row);
      entryCount++;
    }
    if (rows.length) out[dex] = rows;
  }

  const dest = path.join(__dirname, "..", "js", "data", "spawns.json");
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log(`Wrote spawns for ${Object.keys(out).length} species, ${entryCount} entries -> ${dest}`);
}
main();
