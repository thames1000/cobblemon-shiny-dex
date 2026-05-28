# ✨ ShinyDex HQ

A companion web app for building a **shiny living dex** in the **Cobblemon × Create** Minecraft modpack.

It's a zero-build static PWA (plain HTML/CSS/JS) — works offline, installs to your phone/desktop, and
deploys straight to GitHub Pages. All progress is **manual** and stored in your browser's `localStorage`
(export/import for backup). The reference roster is **bundled**, not read from your save.

## Tools

| Tab | Status | What it does |
|-----|--------|--------------|
| **Dex** | ✅ Phase 1 | Grid of all 1025 National Dex species. Tap to cycle `Seen → Caught → ✨Shiny → 📦Boxed`. Filter by gen / state, search, live shiny %. |
| **Mega/GMax** | ✅ Phase 1 | Separate "wing" tracking Mega Stone / GMax-Factor **capability** (Mega/GMax are temporary battle states, not boxable forms). Doesn't dilute the main dex %. |
| **Hunt** | ✅ Phase 2 | Chain (Unchained), Breeding (Cobbreeding Masuda), and raw-encounter logger with editable mod odds. |
| **Spawns** | ✅ Phase 3 | Forward (by Pokémon → biomes/rarity/time + best AFK spot) and reverse (by biome → species) lookup. Complements the in-game PokéNav. |
| **Farm** | 🚧 Phase 4 | Generic apricorn-farm sizing + encounter-farm throughput → expected time-to-shiny. |
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

## Data

- `scripts/build-species.js` regenerates `js/data/species.json` (all 1025: dex/name/types/gen) from PokeAPI.
  Run `node scripts/build-species.js` when the pack updates Cobblemon.
- `scripts/build-spawns.js` regenerates `js/data/spawns.json` from Cobblemon's `spawn_pool_world` JSON
  (sparse-clone command in the script header). Base Cobblemon ships natural spawns for ~823 species; the rest
  are obtained via evolution/breeding/fossil/trade/addon datapacks.
- `js/data/forms.json` is the Mega/Primal/GMax list from the **Mega Showdown** mod (hand-authored; verify
  against your installed version).
- Sprites are loaded on demand from the public PokeAPI sprite repo and cached by the service worker.

## Modpack mechanics baked in (defaults — all will be editable in-app)

- Base shiny rate **1/8192** (Cobblemon `shinyRate`).
- **Unchained** chaining: KO-streak thresholds 100→1/4096, 300→~1/2731, 500+→1/2048 (capped).
- **Cobbreeding** Masuda: different-OT parents → ×4 shiny rate.
