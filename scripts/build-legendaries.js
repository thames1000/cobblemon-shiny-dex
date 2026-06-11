#!/usr/bin/env node
/* Build js/data/legendaries.json — the Legendary tab's roster + farming metadata.
 *
 * Unlike the other build scripts, this isn't derived from a Cobblemon source dump:
 * Cobbleverse summons legendaries through THREE systems that the modpack's own
 * datapack reconfigures (LegendaryMonuments trial-spawners, LumyMon altars, and
 * COBBLEVERSE-DP quest rewards). The roster below is curated from decompiling the
 * Cobbleverse 1.7.31 jars/datapacks (LegendaryMonuments 7.8 + LumyMon 0.6.5), so
 * treat tier/structure assignments as "verified by decompile, confirm in-game."
 *
 * Shiny rate: the Legendary Monuments mod gives every legendary it spawns a flat
 * 2% shiny chance (1/50). That is the documented, verified figure. LumyMon-altar /
 * DP-quest summons aren't independently confirmed, so the calculator's rate is
 * editable and defaults to 2%.
 *
 * Re-spawnability tiers (the axis that matters for shiny farming):
 *   trial          — free, infinite re-summon at a trial spawner (no item). Best
 *                    for shiny grinding: just re-trigger at 2% until it's shiny.
 *   renewable      — gating item is mineable; re-summon by mining more relics/ore.
 *   structure-loot — gating item is one-time structure loot. The ONLY way to re-roll
 *                    is a fresh structure → these are the resource-world farm targets.
 *   quest          — advancement / playthrough-gated. One summon per playthrough;
 *                    a world/structure reset does NOT re-arm it (advancements persist).
 */
const fs = require("fs");
const path = require("path");

const tiers = [
  { key: "trial", label: "Free re-summon", icon: "♻️",
    desc: "Trial spawner — no item consumed. Re-trigger infinitely at 2% until shiny. No reset needed; best shiny farm.",
    farm: "infinite" },
  { key: "renewable", label: "Renewable (mineable)", icon: "⛏️",
    desc: "Gating item drops from worldgen ore/relics. Re-summon as fast as you can mine the item — no reset needed.",
    farm: "mine" },
  { key: "structure-loot", label: "One-time structure loot", icon: "🗝️",
    desc: "Gating item is one-time loot baked into a structure. The only way to re-roll the 2% shiny is a freshly generated structure → resource-world reset targets.",
    farm: "reset" },
  { key: "quest", label: "Quest / playthrough-gated", icon: "🧩",
    desc: "Unlocked by an advancement / boss-defeat chain, one summon per playthrough. A reset does NOT re-arm it — the 2% shot is effectively one-and-done.",
    farm: "none" },
];

// dex, tier, system label, /locate structure ids, optional note (gating item etc.)
// shiny denom is a flat 50 (2%) everywhere; override per-entry only if ever verified otherwise.
const L = (dex, tier, sys, struct = [], note = "") => ({ dex, tier, shiny: 50, sys, struct, note });

const list = [
  // ---- trial: free infinite re-summon (Legendary Monuments spawners) ----
  L(243, "trial", "Legendary Beast spawner", [], "Roaming-beast trial spawner."),
  L(244, "trial", "Legendary Beast spawner", []),
  L(245, "trial", "Legendary Beast spawner", []),
  L(638, "trial", "Swords of Justice spawner", []),
  L(639, "trial", "Swords of Justice spawner", []),
  L(640, "trial", "Swords of Justice spawner", []),
  L(647, "trial", "Swords of Justice spawner", [], "Keldeo — after the trio."),
  L(643, "trial", "Tao trio spawner", ["legendarymonuments:dragonspiraltower"]),
  L(644, "trial", "Tao trio spawner", ["legendarymonuments:dragonspiraltower"]),
  L(646, "trial", "Tao trio spawner", ["legendarymonuments:kyuremcave"]),
  L(720, "trial", "Hoopa pyramid", ["legendarymonuments:hoopa_pyramid"]),
  L(789, "trial", "Cosmog spawner", []),
  L(800, "trial", "Necrozma spawner", []),
  L(888, "trial", "Zacian — Sword", ["legendarymonuments:sword"]),
  L(889, "trial", "Zamazenta — Shield", ["legendarymonuments:shield"]),
  L(890, "trial", "Eternatus cocoon", ["legendarymonuments:eternatus_cocoon"]),
  L(896, "trial", "Glastrier spawner", []),
  L(897, "trial", "Spectrier spawner", []),
  L(898, "trial", "Calyrex spawner", []),

  // ---- renewable: mineable gating item ----
  L(377, "renewable", "Regi relic (mined)", ["cobbleverse:legendary/regirock"], "Relic drops from worldgen rock ore."),
  L(378, "renewable", "Regi relic (mined)", ["cobbleverse:legendary/regice"], "Relic drops from worldgen ice ore."),
  L(379, "renewable", "Regi relic (mined)", ["cobbleverse:legendary/registeel"], "Relic drops from worldgen steel ore."),
  L(894, "renewable", "Regi relic (mined)", [], "Regieleki — relic from electron ore."),
  L(895, "renewable", "Regi relic (mined)", [], "Regidrago — relic from dragon ore."),
  L(382, "renewable", "Kyogre gem (mined)", ["cobbleverse:legendary/kyogre"]),
  L(383, "renewable", "Earth Core (mined)", ["cobbleverse:legendary/groudon"], "Core crafted from mined geostone/heatstone."),
  L(384, "renewable", "Sky Core (chained)", ["cobbleverse:sky_pillar"], "Sky Core chains off Kyogre + Groudon gems."),

  // ---- structure-loot: one-time item → resource-world farm targets ----
  L(385, "structure-loot", "Jirachi — Melodic Tape", ["cobbleverse:mythical/jirachi"], "Melodic Tape is non-craftable, baked into a barrel in the structure NBT."),
  L(487, "structure-loot", "Giratina — Griseous Key", ["legendarymonuments:turnback_cave"], "Key from Turnback Cave chest. (Renewable alt: Distortion Portal from mined ore.)"),
  L(1001, "structure-loot", "Wo-Chien — Ruin Seal", ["legendarymonuments:grasswither_shrine"], "Seal: no recipe/loot/advancement — feeds the radar."),
  L(1002, "structure-loot", "Chien-Pao — Ruin Seal", ["legendarymonuments:icerend_shrine"], "Seal: no recipe/loot/advancement — feeds the radar."),
  L(1003, "structure-loot", "Ting-Lu — Ruin Seal", ["legendarymonuments:groundblight_shrine"], "Seal: no recipe/loot/advancement — feeds the radar."),
  L(1004, "structure-loot", "Chi-Yu — Ruin Seal", ["legendarymonuments:firescourge_shrine"], "Seal: no recipe/loot/advancement — feeds the radar."),

  // ---- quest: one summon per playthrough (advancement-gated) ----
  L(144, "quest", "Kanto bird — feather", ["cobbleverse:legendary/articuno"]),
  L(145, "quest", "Kanto bird — feather", ["cobbleverse:legendary/zapdos"]),
  L(146, "quest", "Kanto bird — feather", ["cobbleverse:legendary/moltres"]),
  L(150, "quest", "Mewtwo quest", []),
  L(151, "quest", "Mew quest", ["cobbleverse:mythical/mew"]),
  L(249, "quest", "Lugia — wing", ["legendarymonuments:lugia_temple", "cobbleverse:whirl_island"]),
  L(250, "quest", "Ho-Oh — wing", ["cobbleverse:bell_tower", "cobbleverse:burned_tower"]),
  L(251, "quest", "Celebi quest", ["cobbleverse:celebi_shrine", "cobbleverse:secret_garden"]),
  L(380, "quest", "Eon — dew", ["legendarymonuments:southern_island"]),
  L(381, "quest", "Eon — dew", ["legendarymonuments:southern_island"]),
  L(386, "quest", "Deoxys quest", ["cobbleverse:mythical/deoxys"]),
  L(480, "quest", "Lake guardian", ["legendarymonuments:lake_acuity"]),
  L(481, "quest", "Lake guardian", ["legendarymonuments:lake_verity"]),
  L(482, "quest", "Lake guardian", ["legendarymonuments:lake_valor"]),
  L(483, "quest", "Creation trio", ["cobbleverse:spear_pillar"]),
  L(484, "quest", "Creation trio", ["cobbleverse:spear_pillar"]),
  L(485, "quest", "Heatran quest", ["legendarymonuments:heatran_cave"]),
  L(486, "quest", "Regigigas quest", ["cobbleverse:snowpoint_temple"]),
  L(488, "quest", "Cresselia quest", ["cobbleverse:fullmoon_island", "cobbleverse:crescent_isle"]),
  L(490, "quest", "Manaphy quest", ["cobbleverse:mythical/manaphy"]),
  L(491, "quest", "Darkrai quest", ["cobbleverse:dusk_tower"]),
  L(492, "quest", "Shaymin quest", ["cobbleverse:flower_paradise"]),
  L(493, "quest", "Arceus — Hall of Origin", ["legendarymonuments:hall_of_origin"]),
  L(494, "quest", "Victini — Liberty", ["legendarymonuments:liberty_island"]),
];

list.sort((a, b) => a.dex - b.dex);

const out = { tiers, list, shinyVerifiedFor: "trial", shinyNote: "2% (1/50) is verified for Legendary Monuments summons; LumyMon-altar / DP-quest rates are unconfirmed." };
const dest = path.join(__dirname, "..", "js", "data", "legendaries.json");
fs.writeFileSync(dest, JSON.stringify(out));
console.log(`Wrote ${list.length} legendaries → ${dest}`);
const byTier = {};
for (const e of list) byTier[e.tier] = (byTier[e.tier] || 0) + 1;
console.log("  by tier:", byTier);
