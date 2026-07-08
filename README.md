# ✨ ShinyDex HQ

A companion web app for building a **shiny living dex** in the **Cobblemon × Create** Minecraft modpack.

It's a zero-build static PWA (plain HTML/CSS/JS) — works offline, installs to your phone/desktop, and
deploys straight to GitHub Pages. All progress is **manual** and stored in your browser's `localStorage`
(export/import for backup). The reference roster is **bundled**, not read from your save.

## Tools

| Tab | Status | What it does |
|-----|--------|--------------|
| **Home** | ✅ | Glanceable dashboard: active hunt with live +1 / ✨ Found / 📦 Boxed, living-dex shiny & boxed % (per-gen breakdown), your ★ wishlist, next gaps to box, and recent finds (with a luck chip each). |
| **Dex** | ✅ Phase 1 | Grid of all 1025 National Dex species. Tap to cycle `Seen → Caught → ✨Shiny → 📦Boxed`. Tap 🎯 to start a hunt, ☆ to wishlist. Filter by gen / state / wishlist, search, live shiny %. |
| **Stats** | ✅ | Totals, per-mode breakdown, average encounters/shiny, luckiest & unluckiest finds, finds-over-time chart, and unlockable milestones. |
| **Boxes** | ✅ | Living-dex PC view — 30-slot boxes in National-Dex order showing boxed mons and gaps. "First gap" jumps to the next slot to fill. Tap a slot to edit state (syncs with Dex). |
| **Mega/GMax** | ✅ Phase 1 | Separate "wing" tracking Mega Stone / GMax-Factor **capability** (Mega/GMax are temporary battle states, not boxable forms). Doesn't dilute the main dex %. |
| **Hunt** | ✅ Phase 2 | Chain (Unchained), Breeding (Cobbreeding Masuda), and raw-encounter logger with editable mod odds. |
| **Spawns** | ✅ Phase 3 | Forward (by Pokémon → biomes/rarity/time + best AFK spot), reverse (by biome → species), and **by variant** — including a 🎣 **Magikarp & Gyarados fishing guide** with per-biome odds, expected catches, and expected catches to a ✨shiny for each bait / Luck of the Sea level. Complements the in-game PokéNav. |
| **Farm** | ✅ Phase 4 | Apricorn-farm sizing (apricorns & balls/hr, time-to-target) + encounter-farm time-to-shiny (50/90/99% counts and ETAs). Generic — no mod-specific recipes. |
| **Data** | ✅ | Export / import / reset your progress, **optional** account sign-in for cloud sync, and **Minecraft sync** — import Cobblemon's own **Pokédex `.nbt`** straight off the server (no mod needed), import a **ShinyDex Link** mod export file, or link your server for **live** caught/✨shiny updates ([setup](SETUP-MOD-SYNC.md)). |

## Accounts & cloud sync (optional)

By default the app is **offline-first**: no account, all progress in your browser's
`localStorage`, with JSON Export/Import as backup. If you run it on more than one computer and
want progress to sync, you can **optionally** connect a free [Firebase](https://firebase.google.com)
project for accounts (Google sign-in **and** email/password) and per-user cloud storage.

- Guest mode still works exactly as before — sign-in is purely additive.
- First sign-in uploads your local progress; signing in elsewhere pulls it down. If both sides
  already have data you get a non-destructive **conflict chooser** (use cloud / keep this device / merge).
- The Firebase web config keys are **public by design** (access is enforced by Firestore security
  rules), so they're safe to commit.

Setup is a one-time ~5-minute task — see **[SETUP-CLOUD.md](SETUP-CLOUD.md)**. Until you do it, the
*Account & cloud sync* card on the Data tab simply shows a "not set up" note.

## Run locally

It's static — any web server works. From this folder:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

(Opening `index.html` via `file://` won't work because it `fetch()`es the JSON data — use a server.)

## Deploy to GitHub Pages

This repo is structured so GitHub Pages can serve it **directly from the repo root** — no build step.

1. Push to GitHub.
2. Repo → **Settings → Pages**.
3. **Source:** "Deploy from a branch". **Branch:** `main`, **folder:** `/ (root)`. Save.
4. Wait ~1 min → site is live at `https://<user>.github.io/<repo>/`.

All paths are relative (`./...`), so it works under the `/<repo>/` subpath without changes.

## Deploy to Vercel

Same repo, no build step — Vercel serves the static files from the root. The included
[`vercel.json`](vercel.json) only sets `Cache-Control`/`Service-Worker-Allowed` headers so the
service worker and `index.html` always revalidate (matching the app's network-first SW).

**Git integration (recommended — auto-deploys every push to `main`):**

1. [vercel.com/new](https://vercel.com/new) → **Import** this GitHub repo.
2. Framework Preset: **Other**. Build Command: *(leave empty)*. Output Directory: *(leave empty/`.`)*.
3. **Deploy.** Live in ~10 s at `https://<project>.vercel.app/`. Every later push redeploys.

**Or the CLI:**

```bash
npm i -g vercel
vercel        # first run links/creates the project (preview URL)
vercel --prod # promote to the production domain
```

Vercel serves at the **root** (`/`), not a `/<repo>/` subpath — cleaner URLs and instant cache
invalidation, which is nicer for a PWA. The two hosts are independent origins (each with its own SW
cache), so you can run **both** in parallel during a transition, or point a custom domain at Vercel
and retire Pages.

## Data

- `scripts/build-species.js` regenerates `js/data/species.json` (all 1025: dex/name/types/gen) from PokeAPI.
  Run `node scripts/build-species.js` when the pack updates Cobblemon.
- `scripts/build-berry-guide.js` regenerates `js/data/berry-guide.json` (the **Berries** tab — all 70 berries,
  their effect, and how to get each: 30 wild berries' biomes + preferred mulch, and 40 mutation parent recipes).
  Parsed from the Cobblemon Wiki "Berry Tree" page; sprites load on demand from the wiki via `Special:FilePath`.
- `scripts/build-moves.js` regenerates `js/data/moves.json` (the **Party** tab's move pickers + type-biased random
  generator + Coach) — name/type/category/power/accuracy per move, slimmed from Pokémon Showdown's move dex and
  filtered to moves at least one Pokémon can learn (so Struggle and the like are gone).
- `scripts/build-coach.js` regenerates `js/data/coach.json` — per-species base stats, abilities (incl. the hidden
  one), **legal move pool**, Smogon **tier** (SV singles) and a **legendary** flag (from Showdown's pokedex +
  learnsets + formats-data, keyed by national dex). Tiers/legendary drive the random-team filters (OU = OU+UUBL,
  UU = UU+RUBL; legendary = Sub-Legendary / Restricted Legendary / Mythical). Powers the per-species
  legal-move pickers, the per-Pokémon **Coach** (suggested nature / ability / EVs / moves + type matchups) and the
  whole-party **Team Coach** (rating, shared-weakness risks with teammate suggestions, role gaps, per-mon upgrades).
  Move pools are standard, not Cobblemon-exact.
- **`js/data/spawns.json` is built straight from the real Cobbleverse datapack, not the wiki.** The pipeline is
  two steps:
  1. `scripts/extract-cobbleverse-spawns.js` reads the modpack's bundled `COBBLEVERSE-DP-v29` datapack
     (`data/cobblemon/spawn_pool_world/*.json` — every species, 3119 spawn entries) and writes a complete,
     loss-free dump to `research/cobbleverse-spawns-v29.json` (+ a readable `.md`). Each spawn keeps its
     untouched datapack object plus derived fields; `#cobblemon:` biome tags are resolved via Cobblemon's own
     tag files. Verified losslessly against the datapack (multiset of raw entries matches exactly).
  2. `scripts/build-spawns-datapack.js` turns that into the compact `js/data/spawns.json` the Spawns tab uses,
     applying two rules: (a) the datapack is the source of truth for biomes / rarity / level / weight / time /
     weather / sky / structures / position / Y-moon-slime-fishing notes / weight-multiplier boosts; (b) **biomes
     that don't exist in this modpack are dropped.** The pack ships **no biome mods** (no Aether / Bumblezone /
     BYG / Biomes O' Plenty; Terralith is "credits only"), so only vanilla Minecraft biomes are real — any spawn
     condition pointing only at a foreign-mod biome, or a `#cobblemon` category that resolves to foreign biomes
     only (`is_sky` = Aether, `is_tropical_island`, `is_volcanic`, …), is removed. See
     `research/spawns-comparison.md` for the full old-vs-new diff.

  Quest-obtain details (gating item · radar · prerequisite) and **Raid Den boss** flags aren't in
  `spawn_pool_world`, so they're carried over by dex from the prior data (shown as a 🧩 *Quest summon* note).
  `scripts/build-spawns-wiki.js` (the older community-wiki parser) and `scripts/build-spawns.js` (raw
  `spawn_pool_world` parser) are kept for reference.
- `js/pokedex-nbt.js` parses Cobblemon's per-player Pokédex save — `<world>/pokedex/<xx>/<player-uuid>.nbt`
  (`xx` = the UUID's first two characters) — with a small dependency-free NBT reader, and flattens it into the
  same entry shape the ShinyDex Link mod export uses, so **Data → Import Pokédex .nbt** rides the existing
  upgrade-only merge. Two details it exists to get right:
  1. A species' top-level `aspects` list is a **union across all its forms**, so it can't be trusted for
     shininess or region. Galarian Meowth's record carries `shiny` because the *normal* Meowth is shiny;
     Gimmighoul's carries it because the *roaming* one is. Everything is therefore read per-`formRecords`
     entry — which is also what routes regional forms to the Variants tab and base forms to the national dex.
  2. Cobblemon stores `knowledge` (`NONE`/`ENCOUNTERED`/`CAUGHT`) per form and, separately, which shiny states
     were **seen**. It never records "the shiny was caught". So a species is only marked ✨ when the form is
     `CAUGHT` *and* a shiny of it was seen (`shinyRequiresCaught`, on by default) — the merge is upgrade-only,
     so a false ✨ couldn't be undone by re-importing.
  3. A `formRecords` key is a Pokédex **dex-entry `displayForm`**, lowercased — not a species form name. Its
     `variantToken()` maps all 1472 (species, displayForm) pairs the modpack can produce onto the site's model:
     Mega/GMax/Primal/Eternamax and battle-only states (Zen, Blade, Busted, Crowned…) resolve to the national-dex
     slot; a capability layered on a real variant is unwrapped (`galar-zen` → Galarian Darmanitan,
     `low-key-gmax` → Low-Key Toxtricity, `mega-sx` → Shadow Mewtwo, ZA Mega's `megae` → Eternal Floette); and
     the handful of dex forms named differently from their aspect are aliased (Genesect's dex says
     Fire/Ice/Water/Electric, the aspects are the *drives*). See `research/cobbleverse-variants.md`.
- `scripts/build-karp-patterns.js` regenerates `js/data/karp-patterns.json` — the **Magikarp Jump** fishing
  model behind *Spawns → By Variant*. The normal spawns pipeline treats `magikarp_jump` as cosmetic and
  collapses it, so all 41 rows read "uncommon · fishing · any overworld"; this keeps the per-biome
  `weightMultiplier`s that actually separate the 31 patterns. All are fishing-only, `uncommon` bucket,
  and need a **Lure I+** Poké Rod. Multipliers **stack**, so a Dark Forest (`spooky` × `magical`) is ×15
  for Saucy Violet. The bucket curve (`weight ^ 1/(1.29 + 0.2·(tier−1))`, `tier` = bait `rarity_bucket` +
  Luck of the Sea) and the shiny reroll (`(value+1)/(shinyRate+1)` on top of 1/8192) are decompiled from
  the jar — see [`research/magikarp-jump-patterns.md`](research/magikarp-jump-patterns.md). **Starf Berry**
  is the only *berry* with a shiny reroll (1/8192 → 1/1366).
- `js/data/forms.json` is the Mega/Primal/GMax list from the **Mega Showdown** mod (hand-authored; verify
  against your installed version).
- Sprites are loaded on demand from the public PokeAPI sprite repo and cached by the service worker.

## Modpack mechanics baked in (defaults — all will be editable in-app)

- Base shiny rate **1/8192** (Cobblemon `shinyRate`).
- **Unchained** chaining: KO-streak thresholds 100→1/4096, 300→~1/2731, 500+→1/2048 (capped).
- **Cobbreeding** Masuda: different-OT parents → ×4 shiny rate.
