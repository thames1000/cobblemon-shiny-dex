# Magikarp Jump patterns — where to fish, and what a shiny costs

Everything here is read from **COBBLEVERSE 1.7.31** (Cobblemon 1.7.3 + `COBBLEVERSE-DP-v29`) or
decompiled from `Cobblemon-fabric-1.7.3+1.21.1.jar`. Generated data:
[`js/data/karp-patterns.json`](../js/data/karp-patterns.json) via
[`scripts/build-karp-patterns.js`](../scripts/build-karp-patterns.js). Surfaced in the app under
**Spawns → By Variant**.

## Why this needed its own dataset

`scripts/build-spawns-datapack.js` lists `magikarp_jump` in its `COSMETIC` map, which strips the aspect
so identical rows collapse. That's right for the normal Spawns view — otherwise all 41 rows read
"uncommon · fishing · any overworld" — but it throws away the only thing that separates the 31 patterns:
their per-biome `weightMultiplier(s)`. So `spawns.json` shows Magikarp with 41 indistinguishable rows.

## The mechanics

- All 31 patterns are **`fishing`** spawns in the **`uncommon`** bucket with **`minLureLevel: 1`**.
  Cobblemon reads that level from the rod's **Lure** enchantment (`PokerodItem` → `Enchantments.LURE`,
  yarn `field_9100`; the sibling read is `LUCK_OF_THE_SEA` = `field_9114`). **No Lure ⇒ no patterns.**
  Higher Lure does nothing extra — no pattern has a `maxLureLevel` or a second threshold.
- Patterns spawn in `#cobblemon:is_overworld`, i.e. **anywhere**. Biome only changes the odds.
- **Multipliers stack.** Saucy Violet is ×3 in `spooky` and ×5 in `magical`; a **Dark Forest is both**,
  so it's **×15** there — the single best spot for it.
- Rows conditioned on `skyLight 0-7` are the wiki's **"Underground"** multiplier. Minecraft sky light is
  **time-independent**, so this is depth/cover, *not* night. (I initially mis-read it as a night bonus;
  the ratios settle it — Skelly's dark row is 6 vs a base of 2, exactly the wiki's "3× Underground",
  and Orange Forehead/Mask are 10 vs 2 = "5× Underground".)
- **Gyarados has no patterned spawns.** Its dex entry lists only `Normal` and `Mega`. The pattern is
  inherited when a patterned Magikarp evolves.

## Bucket odds (decompiled)

`PokeRodFishingBobberEntity.planSpawn()` constructs

```
BucketNormalizingInfluence(tier = Σ(bait rarity_bucket) + luckOfTheSeaLevel)
```

and `affectBucketWeights()` is, verbatim:

```
if (tier == 0) return
d = firstTier + gradient * (tier - 1)      // defaults 1.29, 0.2
weight_i = weight_i ^ (1 / d)              // then the spawner normalises
```

Base weights come from `config/cobblemon/spawning/best-spawner-config.json`. **COBBLEVERSE ships
88.5 / 10 / 1.2 / 0.3**, so an unbuffed cast is a **10%** shot at the uncommon bucket.

Two things worth flagging:

1. Plugging in **base Cobblemon**'s `94.3 / 5 / 0.5 / 0.2` gives exactly **5.00%** at tier 0 — precisely
   the "flat 5% chance" the Cobblemon wiki quotes. That independently confirms the model.
2. The wiki's *"Luck Of The Sea boosting that chance by 2.5% per level, max 12.5%"* is a **linear
   approximation**. The real curve on base weights is 5.00 → **9.09 → 11.75 → 14.10%**, and on this
   server's weights **10.00 → 14.97 → 17.68 → 19.83%**.

## Shiny odds (decompiled)

`FishingSpawnCause.Companion.shinyReroll()`:

```
if (pokemon.shiny) return
if (shinyRate <= 0) return
roll = Random.nextInt(0, shinyRate + 1)
if (roll <= effect.value) pokemon.shiny = true
```

So a `shiny_reroll` bait adds `(value + 1) / (shinyRate + 1)` **on top of** the normal 1/`shinyRate` roll.
The guide's **base shiny rate is editable** (defaults to the site's `config.baseShinyRate`, 1/8192) so you can
model a boosted server rate; every "→ ✨ shiny" number and the reroll fractions scale with it.

| Bait | `shiny_reroll` | `rarity_bucket` | Effective shiny |
|---|---|---|---|
| none | — | 0 | 1 / 8192 |
| **Starf Berry** 🫐 | 4 | 0 | **1 / 1366** |
| Golden Apple | 1 | 1 | 1 / 2731 |
| Enchanted Golden Apple | 9 | 10 | 1 / 745 |

**Starf Berry is the only *berry* with a shiny reroll.** Enchanted Golden Apple is strictly stronger and
also shifts the bucket, but it isn't a berry.

Not modelled: `typing` and `egg_group` baits reweight spawns *within* the bucket
(`SpawnBaitInfluence.affectWeight()`). Starf Berry and the apples carry neither, so their numbers are exact.

## Expected catches

`P(pattern per catch) = P(uncommon bucket | tier) × (pattern's effective weight ÷ total uncommon fishing
weight in that biome)`. The pool is computed from the datapack for every vanilla overworld biome, in two
scenarios (open sky / underground), with Lure I. Spawns gated on structures, bobber type, or a specific
rod are excluded — they'd inflate a generic pool.

Worked example — **Skelly**, Dark Forest, open sky (×5 `spooky`):

| Setup | uncommon | P(Skelly) | catches | → ✨ shiny |
|---|---|---|---|---|
| no bait, no Luck | 10.00% | 0.446% | 224 | 1,835,008 |
| Luck III | 19.83% | 0.885% | 113 | 925,620 |
| Starf Berry | 10.00% | 0.446% | 224 | **305,897** |
| Starf Berry + Luck III | 19.83% | 0.885% | 113 | **154,301** |
| Ench. Golden Apple + Luck III | 26.63% | 1.189% | 84 | **62,657** |

Best spot per pattern (no bait, no Luck):

| Pattern | Best | Boost |
|---|---|---|
| Saucy Violet / Violet Raindrops | **Dark Forest** (surface) | ×15 (spooky × magical) |
| Orange Forehead / Orange Mask | Deep Dark (underground) | ×5 |
| Saucy Blue / Blue Raindrops | Ice Spikes (surface) | ×5 |
| Purple Bubbles/Diamonds/Patches | Mangrove Swamp (surface) | ×5 |
| Skelly | Deep Dark (underground) | ×3 |

## Also fixed here

The 62 Magikarp/Gyarados entries in `variants.json` carried **no `aspects`**, so the live mod sync could
never route them — a caught Apricot Stripes Magikarp just marked base Magikarp. They now carry
`magikarp-jump-<aspect>`. (The `.nbt` importer was unaffected: Magikarp's dex entry has only a `Normal`
form, so patterns never reach the Pokédex file at all — the mod sync is the *only* way to track them.)

Two aspects are named in the opposite order from the wiki (`blue-saucy` → "Saucy Blue",
`violet-saucy` → "Saucy Violet"), so variant ids can't be derived from the aspect by string-munging;
`build-karp-patterns.js` keeps an explicit alias.
