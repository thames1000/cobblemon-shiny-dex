# ✨ ShinyDex HQ

A companion web app for building a **shiny living dex** in the **Cobblemon × Create** Minecraft modpack.

It's a zero-build static PWA (plain HTML/CSS/JS) — works offline, installs to your phone/desktop, and
deploys straight to GitHub Pages. All progress is **manual** and stored in your browser's `localStorage`
(export/import for backup). The reference roster is **bundled**, not read from your save.

## Tools

| Tab | Status | What it does |
|-----|--------|--------------|
| **Dex** | ✅ Phase 1 | Grid of all 1025 National Dex species. Tap to cycle `Seen → Caught → ✨Shiny → 📦Boxed`. Filter by gen / state, search, live shiny %. |
| **Boxes** | ✅ | Living-dex PC view — 30-slot boxes in National-Dex order showing boxed mons and gaps. "First gap" jumps to the next slot to fill. Tap a slot to edit state (syncs with Dex). |
| **Mega/GMax** | ✅ Phase 1 | Separate "wing" tracking Mega Stone / GMax-Factor **capability** (Mega/GMax are temporary battle states, not boxable forms). Doesn't dilute the main dex %. |
| **Hunt** | ✅ Phase 2 | Chain (Unchained), Breeding (Cobbreeding Masuda), and raw-encounter logger with editable mod odds. |
| **Spawns** | ✅ Phase 3 | Forward (by Pokémon → biomes/rarity/time + best AFK spot) and reverse (by biome → species) lookup. Complements the in-game PokéNav. |
| **Farm** | ✅ Phase 4 | Apricorn-farm sizing (apricorns & balls/hr, time-to-target) + encounter-farm time-to-shiny (50/90/99% counts and ETAs). Generic — no mod-specific recipes. |
| **Data** | ✅ | Export / import / reset your progress. |

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
  their effect, and how to get each: wild biomes + preferred mulch, mutation parent recipes, or Pokémon drops).
  Parsed from the Cobblemon Wiki "Berry Tree" page; sprites load on demand from the wiki via `Special:FilePath`.
- `scripts/build-spawns.js` regenerates `js/data/spawns.json` from a `spawn_pool_world` directory.
  This pack uses **Cobbleverse** spawn rules (its bundled `COBBLEVERSE-DP-*.zip` datapack), which cover
  **1017 species** — including legendaries, mythicals and paradox mons that have *no* spawn in base Cobblemon.
  Those legendaries are found at named structures / custom sites (e.g. Articuno Tower, Whirl Island, Sky Pillar),
  surfaced in the Spawns tab as 🏛 site chips alongside any weather/moon weight boosts. See the script header for
  how to point it at the datapack. Only 8 craft/fossil mons (Type: Null, Silvally, Melmetal, the fossil duos,
  Gholdengo) have no wild spawn.
- `js/data/forms.json` is the Mega/Primal/GMax list from the **Mega Showdown** mod (hand-authored; verify
  against your installed version).
- Sprites are loaded on demand from the public PokeAPI sprite repo and cached by the service worker.

## Modpack mechanics baked in (defaults — all will be editable in-app)

- Base shiny rate **1/8192** (Cobblemon `shinyRate`).
- **Unchained** chaining: KO-streak thresholds 100→1/4096, 300→~1/2731, 500+→1/2048 (capped).
- **Cobbreeding** Masuda: different-OT parents → ×4 shiny rate.
