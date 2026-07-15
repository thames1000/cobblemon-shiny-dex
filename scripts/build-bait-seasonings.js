/* build-bait-seasonings.js — the seasonings you can cook into a Poké Bait.
 *
 * A Poké Bait (honey_bottle + mushroom + wheat -> 4x, empty on its own) takes up to
 * 3 seasonings from the `cobblemon:recipe_filters/bait_seasoning` tag, exactly like a
 * Poké Snack. Each seasoning that is a registered `spawn_bait` attaches its effects to
 * the bait (BaitSeasoningProcessor). This emits every such seasoning with its effects
 * normalised to the app's field vocabulary (species types/eggGroups/ev).
 *
 * Effects are the ground truth in data/cobblemon/spawn_bait_effects/. Extract them:
 *   unzip -oq ~/Downloads/Cobblemon-fabric-1.7.3+1.21.1.jar \
 *     'data/cobblemon/spawn_bait_effects/*' -d /tmp/baits
 *   node scripts/build-bait-seasonings.js /tmp/baits/data/cobblemon/spawn_bait_effects
 *
 * Fishing effect semantics (decompiled — see fishing-bait-bucket-math memory):
 *   rarity_bucket : summed across seasonings -> BucketNormalizing tier (shifts which
 *                   bucket you hook; ONLY the apples/melon/carrot carry it — no berry)
 *   shiny_reroll  : each is an independent reroll of +(value+1)/(rate+1)
 *   typing/egg_grp: x10 weight WITHIN the bucket for a matching species (mergeEffects
 *                   sums stacked copies, then ceil)
 *   ev            : hard filter — only species yielding that EV can be hooked
 *   bite_time     : fractional bite-speed reduction (stacks, doesn't change species)
 *   nature/iv/gender/level/friendship/ha/pokemon_chance/drops_reroll : post-catch traits
 */
const fs = require("fs");
const path = require("path");

const DIR = process.argv[2] || "/tmp/baits/data/cobblemon/spawn_bait_effects";
const OUT = process.argv[3] || path.join(__dirname, "..", "js", "data", "bait-seasonings.json");

// The 5 non-berry fruits in the bait_seasoning tag (berries are all included via
// #cobblemon:berries). apple/melon/carrot/golden_apple/EGA live in fruits/.
const FRUITS = new Set(["apple", "enchanted_golden_apple", "glistering_melon_slice", "golden_apple", "golden_carrot"]);

const EGG = { water_1: "Water 1", water_2: "Water 2", water_3: "Water 3", human_like: "Human-Like",
  field: "Field", monster: "Monster", dragon: "Dragon", grass: "Grass", fairy: "Fairy", flying: "Flying",
  bug: "Bug", mineral: "Mineral", amorphous: "Amorphous", ditto: "Ditto", undiscovered: "Undiscovered" };
const EV = { hp: "HP", atk: "Attack", def: "Defense", spa: "Sp. Atk", spd: "Sp. Def", spe: "Speed" };
const STAT = EV; // nature/iv subcategories use the same stat slugs

const title = (s) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const sub = (e) => (e.subcategory || "").split(":").pop();

function main() {
  const files = [];
  for (const f of fs.readdirSync(path.join(DIR, "berries"))) if (f.endsWith(".json")) files.push(["berries", f]);
  for (const f of fs.readdirSync(path.join(DIR, "fruits"))) if (f.endsWith(".json") && FRUITS.has(f.slice(0, -5))) files.push(["fruits", f]);

  const out = [];
  for (const [dir, f] of files) {
    const data = JSON.parse(fs.readFileSync(path.join(DIR, dir, f), "utf8"));
    const item = data.item;                                   // e.g. cobblemon:occa_berry
    const base = f.slice(0, -5);
    const s = { id: item, name: title(base) };

    let rarity = 0, shiny = 0, bite = 0;
    const eggGroups = [], traits = [];
    for (const e of data.effects || []) {
      const t = e.type.split(":").pop();
      const v = e.value, ch = e.chance;
      if (t === "rarity_bucket") rarity += v;
      else if (t === "shiny_reroll") shiny = Math.max(shiny, v);   // one item never stacks its own reroll
      else if (t === "bite_time") bite += v;
      else if (t === "typing") s.type = sub(e);
      else if (t === "egg_group") eggGroups.push(EGG[sub(e)] || title(sub(e)));
      else if (t === "ev") s.ev = EV[sub(e)] || sub(e);
      else if (t === "nature") traits.push(`${Math.round(ch * 100)}% ${STAT[sub(e)] || sub(e)} nature`);
      else if (t === "iv") traits.push(`+${v} ${STAT[sub(e)] || sub(e)} IV`);
      else if (t === "gender_chance") traits.push(`${Math.round(ch * 100)}% ${sub(e)}`);
      else if (t === "level_raise") traits.push(`+${v} level`);
      else if (t === "friendship") traits.push(`+${v} friendship`);
      else if (t === "ha_chance") traits.push(`${Math.round(ch * 100)}% hidden ability`);
      else if (t === "pokemon_chance") traits.push("higher catch chance");
      else if (t === "drops_reroll") traits.push("reroll held item");
    }
    if (rarity) s.rarity = rarity;
    if (shiny) s.shiny = shiny;
    if (bite) s.biteTime = +bite.toFixed(3);
    if (eggGroups.length) s.eggGroups = eggGroups;
    if (traits.length) s.traits = traits;

    // Primary display group (a seasoning may carry several effects; group by the one
    // that most shapes what/how-rare you hook). Rarity first — those are the only ones
    // that change the bucket (and so Magikarp Jump pattern odds).
    s.group = s.rarity ? "Rarity (bucket)"
      : s.shiny ? "Shiny reroll"
      : s.type ? "Type"
      : s.eggGroups ? "Egg group"
      : s.ev ? "EV yield"
      : s.biteTime ? "Bite time"
      : s.traits ? "Traits (post-catch)"
      : "No fishing effect";

    // Human-readable effect summary (mirrors berries.json `effect`).
    const parts = [];
    if (s.rarity) parts.push(`rarity +${s.rarity} (shifts bucket toward rarer)`);
    if (s.shiny) parts.push(`✨ +${s.shiny + 1}/${8193} shiny reroll`);
    if (s.type) parts.push(`×10 ${title(s.type)}-type`);
    if (s.eggGroups) parts.push(`×10 ${s.eggGroups.join(" / ")} egg group`);
    if (s.ev) parts.push(`only ${s.ev}-EV yielders`);
    if (s.biteTime) parts.push(`−${Math.round(s.biteTime * 100)}% bite time`);
    if (s.traits) parts.push(s.traits.join(", "));
    s.effect = parts.join(" · ") || "no fishing effect";
    out.push(s);
  }

  out.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  fs.writeFileSync(OUT, JSON.stringify(out));
  const g = {};
  for (const s of out) g[s.group] = (g[s.group] || 0) + 1;
  console.log(`${out.length} bait seasonings -> ${OUT}`);
  console.log("  groups:", JSON.stringify(g));
}
main();
