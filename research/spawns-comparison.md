# Spawns: datapack vs. previous (wiki) data — comparison

Regenerated `js/data/spawns.json` from the **real COBBLEVERSE-DP-v29 datapack** (was wiki-derived).
Biomes filtered to ones that **exist in this modpack** (vanilla only — no biome mods installed).

## Totals

| | Previous (wiki) | New (datapack) |
|--|--|--|
| species with data | 1023 | 1021 |
| distinct biome labels | 111 | 76 |

- Foreign/non-existent biome refs removed: **796**
- Wild-spawn entries dropped as unreachable (foreign biome only): **279**

## Biome labels removed (existed in old data, gone now — not in this pack)

- aether  _(old uses: 185)_
- any biome  _(old uses: 20)_
- any nether  _(old uses: 24)_
- arid / desert  _(old uses: 116)_
- aspen glade  _(old uses: 2)_
- blooming valley  _(old uses: 1)_
- crystal canyon  _(old uses: 8)_
- crystalline chasm  _(old uses: 3)_
- dryland  _(old uses: 2)_
- floral meadow  _(old uses: 41)_
- has block — mud  _(old uses: 15)_
- howling constructs  _(old uses: 16)_
- jacaranda glade  _(old uses: 2)_
- maple woods  _(old uses: 3)_
- nether — basalt deltas  _(old uses: 17)_
- nether — crimson forest  _(old uses: 10)_
- nether — desert  _(old uses: 9)_
- nether — forest  _(old uses: 19)_
- nether — frozen  _(old uses: 11)_
- nether — fungus  _(old uses: 16)_
- nether — mountain  _(old uses: 4)_
- nether — overgrowth  _(old uses: 18)_
- nether — quartz  _(old uses: 8)_
- nether — soul fire  _(old uses: 3)_
- nether — soul sand  _(old uses: 3)_
- nether — toxic  _(old uses: 4)_
- nether — warped forest  _(old uses: 5)_
- nether — wasteland  _(old uses: 17)_
- pollinated fields  _(old uses: 2)_
- sakura grove  _(old uses: 2)_
- sakura valley  _(old uses: 2)_
- shrubland  _(old uses: 1)_
- sky  _(old uses: 70)_
- skyroot forest  _(old uses: 50)_
- skyroot grove  _(old uses: 36)_
- skyroot meadow  _(old uses: 36)_
- skyroot woodland  _(old uses: 50)_
- snowy forest  _(old uses: 53)_
- steppe  _(old uses: 1)_
- the bumblezone  _(old uses: 11)_
- the end  _(old uses: 5)_
- thermal  _(old uses: 21)_
- tropical island  _(old uses: 131)_
- volcanic  _(old uses: 36)_
- warped desert  _(old uses: 2)_
- wasteland  _(old uses: 2)_
- wasteland steppe  _(old uses: 2)_
- white cliffs  _(old uses: 1)_

## Biome labels added (new from datapack)

- arid  _(new uses: 103)_
- mangrove swamp  _(new uses: 15)_
- mushroom  _(new uses: 63)_
- nether  _(new uses: 18)_
- nether basalt  _(new uses: 17)_
- nether crimson  _(new uses: 8)_
- nether desert  _(new uses: 7)_
- nether fungus  _(new uses: 14)_
- nether mountain  _(new uses: 4)_
- nether soul fire  _(new uses: 3)_
- nether soul sand  _(new uses: 3)_
- nether warped  _(new uses: 5)_
- nether wasteland  _(new uses: 15)_

## Foreign biome refs dropped (raw → count of spawn conditions)

- `#aether:is_aether` × 189
- `#cobblemon:is_tropical_island` × 121
- `#cobblemon:is_sky` × 59
- `#cobblemon:is_snowy_forest` × 54
- `the_bumblezone:floral_meadow` × 49
- `aether:skyroot_woodland` × 48
- `aether:skyroot_forest` × 48
- `the_bumblezone:howling_constructs` × 39
- `aether:skyroot_meadow` × 33
- `aether:skyroot_grove` × 33
- `#cobblemon:is_volcanic` × 28
- `#cobblemon:nether/is_forest` × 19
- `#cobblemon:nether/is_overgrowth` × 14
- `#cobblemon:is_thermal` × 12
- `#the_bumblezone:the_bumblezone` × 11
- `#cobblemon:nether/is_frozen` × 9
- `the_bumblezone:crystal_canyon` × 7
- `#cobblemon:nether/is_quartz` × 7
- `biomesoplenty:crystalline_chasm` × 2
- `terralith:sakura_grove` × 2
- `terralith:sakura_valley` × 2
- `byg:warped_desert` × 2
- `the_bumblezone:pollinated_fields` × 2
- `#cobblemon:end` × 1
- `#cobblemon:lush` × 1
- `terralith:blooming_valley` × 1
- `terralith:steppe` × 1
- `terralith:white_cliffs` × 1
- `#cobblemon:is_shrubland` × 1

## Species coverage change

- In old but **not** in new (no reachable spawn/summon now): **2** → 233, 647
- In new but not in old: **0** → none