# Every form in the COBBLEVERSE modpack — variant vs Mega/GMax

Audit of **COBBLEVERSE 1.7.31** (`Jkb29YJU`, MC 1.21.1 Fabric), the pack this server runs
(matches the `COBBLEVERSE-DP-v29` datapack and Cobblemon 1.7.3 the server has).

Machine-readable companion: [`cobbleverse-variants.json`](cobbleverse-variants.json) — all 460
forms with `species / dex / form / aspects / labels / source / class / inSite`.

## Where forms actually come from

All 133 mod jars in the pack were scanned. Only **four** jars ship Cobblemon species data, and the
**datapack** is a fifth source that `scripts/build-variants.js` never reads:

| Source | Species files | Forms it contributes | Mechanism |
|---|---|---|---|
| `Cobblemon-fabric-1.7.3` | 1025 | 317 | `species/*.json` → `forms[]` |
| `mega_showdown-1.7.3` | 24 (full overrides) | 50 | `species/*.json` + `species_additions/` |
| `zamega-1.7.1` (ZA Mega) | 0 | 49 | `species_additions/**/*_mega.json` |
| `COBBLEVERSE-DP-v29.zip` | 12 (full overrides) | 44 | `species/` + **383** `species_additions/` |
| `cobblemonraiddens` | 0 | 0 | one `species_features/raid.json` only |

**This is why Armored/Shadow Mewtwo and Shadow Lugia are missing from the site.** They are not
Cobblemon forms and not Mega Showdown forms — they are added by the **COBBLEVERSE datapack itself**,
via `data/cobblemon/species_additions/mewtwo.json` and `lugia.json`, backed by
`species_features/{shadow,armored}.json` (both `flag` aspects) and
`species_feature_assignments/{shadow,armored}.json` (`shadow` → lugia, calyrex; `armored` → mewtwo).

`build-variants.js` only ever reads a `species/` directory, so it sees **none** of the 490
`species_additions` in the pack.

### "All the Mons" (ATM)

`ATMxMSD RP.zip` — **ATM x MSD v3.1.1** by `_Lvnatic` — is a **resourcepack only** (models, textures,
animations: `mewtwo_shadow_mega_x.geo.json`, `0249_lugia/…`). It ships **no data**. There is no ATM
*datapack*: the stats/types/abilities for those models live in `COBBLEVERSE-DP-v29`'s
`species_additions`. The pack's `data/atmxmsd/` namespace is just 4 recipe/interaction files.
The `z DO NOT ENABLE z [ATM x MSD - Credits Only].zip` copy is an empty credits stub.

So ATM = art; COBBLEVERSE DP = data. Both are already installed.

## Totals (merged, load-ordered)

| Class | Forms | Species | Site has | Missing |
|---|---|---|---|---|
| **Mega** | 109 | 87 | 45 species | **42 species / 46 forms** |
| **GMax** | 34 | 32 | 32 | 0 ✅ |
| **Primal** | 3 | 3 | 2 | **1** (Primal Dialga) |
| **Regional** | 74 | — | 74 | 0 ✅ |
| **Variant** (collectible) | 210 | — | 183 | **27** |
| Eternamax / Ultra Burst | 2 | — | 2 | 0 ✅ |
| *Transient (battle-only)* | 28 | — | *excluded* | — |

## Missing → **Variant**

Persistent, distinct appearances. These belong in `variants.json`.

| Dex | Species | Form | Aspect | Source | Note |
|---|---|---|---|---|---|
| 150 | Mewtwo | Shadow | `shadow` | DP | Psychic/**Dark**, own stats + `neuroforce` |
| 150 | Mewtwo | Armored | `armored` | DP | Psychic/**Steel**, own stats + `battlearmor` |
| 249 | Lugia | Shadow | `shadow` | DP | |
| 383 | Groudon | Virus | `virus` | DP | |
| 448 | Lucario | ×9 costumes | `<name>-costume` | DP | cafe, captain, chef, concert, costume_party, holiday, martial_arts, ruins, space |
| 25 | Pikachu | Cosplay, Rock-Star, Pop-Star, PhD, Libre, Belle | `cosplay`/`rock_star`/… | MSD | the Cosplay set |
| 25 | Pikachu | Original, Hoenn, Sinnoh, Unova, Kalos, Alola, World | `cosmetic_item-*` | MSD | **held-item hats**, not species forms — see judgment call |
| 718 | Zygarde | Core | `core-percent` | MSD | |

Calyrex is also assigned the `shadow` feature by the DP with no matching `form` entry — a Shadow
Calyrex appearance may exist as an aspect only. Unconfirmed.

## Missing → **Mega**

46 forms across 42 species. **45 of the 46 come from `zamega` (ZA Mega)**, which the site has never
read; the 46th is Mega Rayquaza:

Raichu (X+Y), Clefable, Victreebel, Starmie, Dragonite, Meganium, Feraligatr, Skarmory, Chimecho,
Staraptor, Froslass, Heatran, Darkrai, Emboar, Excadrill, Scolipede, Scrafty, Eelektross, Chandelure,
Golurk, Chesnaught, Delphox, Greninja, Pyroar, Floette (MegaE), Meowstic, Malamar, Barbaracle,
Dragalge, Hawlucha, Zygarde, Crabominable, Golisopod, Drampa, Magearna (Mega + MegaO), Zeraora,
Falinks, Scovillain, Glimmora, Tatsugiri (Mega + MegaD + MegaS), Baxcalibur.

Plus these extra **forms** on species whose base dex `forms.json` already lists, so a dex-keyed diff
misses them — each needs its own entry:

- **Mega-Z** for Absol (#359), Garchomp (#445), Lucario (#448) — ZA Mega.
- **#150 Mewtwo Mega-SX / SY / AX / AY** (DP) — Megas *of* Shadow/Armored Mewtwo. They need the
  variant **and** the stone, so they only make sense once Shadow/Armored exist as variants.

And one plain bug in `forms.json`:

- **#384 Mega Rayquaza** — exists in base Cobblemon *and* the DP override. Simply absent from `forms.json`.

## Missing → **Primal**

- **#483 Primal Dialga** (`primal` label, DP). `forms.json` has only Kyogre + Groudon.

## Recommended: **exclude** (transient battle states, 28 forms)

Zen · Blade · Busted · Gulping/Gorging · Hangry · Noice Face · School · Pirouette · Ash/Bond ·
Terastal/Stellar · Crowned · Power-Construct · Xerneas Active · Castform weather · Cherrim Sunshine ·
Palafin Hero.

⚠ The site **currently ships Castform (Rainy/Snowy/Sunny), Cherrim (Sunshine) and Palafin (Hero) as
cosmetic variants**. By the "temporary battle state" rule used for Mega/GMax they don't belong there,
but that is existing behavior, not a new bug — left alone.

## What the `.nbt` parser can and can't route

A Pokédex `formRecords` key is a **dex-entry `displayForm`, lowercased** — not a species form name.
(`dex_entries/.../oricorio.json` has `"Pa’u"` with U+2019, and the save's key is exactly `pa’u`.)
Merging every `dex_entries` + `dex_entry_additions` across the pack gives **1472 (species, displayForm)
pairs** — the complete set of keys the parser can ever see. Sweeping all of them through
`variantToken()` + `modEntryVariant()`:

| Outcome | Count |
|---|---|
| → national-dex slot (base form, Mega/GMax/Primal/Eternamax, battle-only state) | 1163 |
| → routed to a `variants.json` entry | 309 |
| → unroutable | **0** ✅ |

Getting to zero took 32 new `variants.json` entries (§ below) plus three bug fixes. All three also
affected the **live mod sync**, not just `.nbt` import:

- **Unown `!` and `?` collided.** `norm("character-!")` and `norm("character-?")` both stripped to
  `"character"`, so `VARIANT_BY_DEXFORM["201|character"]` only ever held `!` — catching Unown `?` marked
  Unown `!`. `normSpeciesName()` now spells them `em`/`qm` (matching the sprite slugs) before stripping.
  All 28 Unown are reachable again.
- **Genesect's drives were unreachable.** Its dex forms are Fire/Ice/Water/Electric; the variants are
  keyed `burn-drive`/`chill-drive`/`douse-drive`/`shock-drive`. Now aliased in the parser.
- **Multi-aspect variants lost to less specific ones.** A Cobblemon catch carries every aspect at once
  (`["paldean","aqua-breed","male",…]`), and `modEntryVariant()` returned the *first* token that hit —
  so Paldean **Aqua** Tauros was recorded as Paldean **Combat**, and all three Tera Ogerpon collapsed
  onto Cornerstone Tera. It now prefers the variant whose aspects are *all* present, most first. 4
  variants were misrouted; now 0, with all 408 reachable by their own name/aspects.

### Behavior change worth knowing

The site's rule is that a regional/cosmetic form updates **only** the Variants tab, never the base-dex
slot (an Alolan Rattata doesn't fill Rattata's national-dex square). Now that Shadow/Armored Mewtwo are
variants, a save that has *only* those two — as this one does — no longer marks **Mewtwo** caught on the
national dex. That is the rule applied consistently, and the merge is upgrade-only, so it never *removes*
a Mewtwo you already had. It just stops crediting one you don't.

The upside is the bug it kills: a shiny Shadow Mewtwo used to mark **base Mewtwo ✨**, permanently
(upgrade-only merge — re-importing couldn't undo it). It now marks Mewtwo-Shadow ✨.

## The 32 variants added

Every one is reachable both from a `.nbt` dex form key and from a mod-sync aspect list.

| Group | Entries |
|---|---|
| `cosmetic` | **Pikachu ×13** — the Cosplay set (Cosplay/Rock-Star/Pop-Star/PhD/Libre/Belle) and the 7 travel caps. Showdown ships a normal *and* shiny sprite for all 13. |
| `regional.hisuian` | **Bergmite** `region-bias-hisui` — plain base-Cobblemon omission. |
| `cobbleverse` *(new group)* | **18**: Mewtwo Shadow + Armored, Lugia Shadow, Groudon Virus, Lucario ×9 costumes, Riolu + Lucario PMD/PSMD scarves, Floette Ange. |

The `cobbleverse` group's art ships only in the **ATM x MSD resourcepack** — no public sprite host has
it — so those entries carry no `slug`/`wikiFile` and `variantArt()` falls back to the base Pokémon's
sprite. No broken images.

PMD vs PSMD scarf was settled from the resourcepack's own resolver
(`0447_riolu/1_riolu_scarf.json`): `cosmetic_item-red_scarf` / `-atmxmsd` → `riolupmd.png`,
`cosmetic_item-green_scarf` / `-atmxmsd2` → `riolupsmd.png`. (Its *shiny* rows swap the two — an RP bug,
cosmetic only.)

Decisions taken along the way:

1. **Pikachu's 7 `cosmetic_item-*` caps** are held-item driven, not persistent forms — but Cobblemon
   *does* give each its own dex entry, so the Pokédex records them and leaving them out would mean 7
   permanently unroutable keys. Included.
2. **Lucario Mega-`<costume>` ×9** are just Mega Lucario in a costume, not nine Megas — and they have no
   dex entry, so they never reach the Pokédex. The 9 costumes are variants; Mega Lucario stays one entry.
3. **Mewtwo Mega-SX/SY/AX/AY** — Mega ∘ variant. `forms.json` is keyed by base dex and can't express
   "Mega of the Shadow form", so the parser maps these dex keys onto the underlying **Shadow**/**Armored**
   variant instead of inventing a Mega entry.
4. **Zygarde `Core`** and the ZA Mega `MegaE`/`MegaD`/`MegaS`/`MegaO`/`MegaC` forms have no dex entry of
   their own beyond the mega keys, which are aliased to their underlying variant.

## Reproducing

```bash
# pack + mods
curl -sL -o cv.mrpack "https://cdn.modrinth.com/data/Jkb29YJU/versions/DN77rBht/COBBLEVERSE%201.7.31.mrpack"
unzip -q cv.mrpack -d mrp && chmod -R u+rwX mrp/overrides   # zip entries ship with 000 perms
python3 -c "import json;[print(f['downloads'][0]) for f in json.load(open('mrp/modrinth.index.json'))['files'] if f['path'].endswith('.jar')]" > urls
xargs -P8 -n1 curl -sLO < urls
```

Then merge, in load order, each source's `species/` (later fully replaces), `species_additions/`
(additive, keyed by `target`), `species_features/` + `species_feature_assignments/`.
