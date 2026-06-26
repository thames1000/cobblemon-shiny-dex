# 🔗 Minecraft mod sync setup (ShinyDex Link)

This connects the **ShinyDex Link** server mod to your website so catches on your
Minecraft server update your dex **automatically** (caught + ✨ shiny), live.

How it fits together:

```
Minecraft server (mod)  --POST serverToken-->  Vercel functions (api/)  --Admin SDK-->  Firestore
                                                                                            |
ShinyDex website (signed in)  <----------------- reads modDex/{uid} -----------------------+
```

The mod authenticates with a shared **server token** (not a Firebase login), so a
small server-side backend (the `api/` folder, deployed as **Vercel functions**)
validates that token and writes to Firestore with the **Admin SDK**. The website
then reads each user's mod-synced catches and merges them in (upgrade-only).

> **Prerequisite:** finish **[SETUP-CLOUD.md](SETUP-CLOUD.md)** first (Firebase project,
> auth, Firestore, and the **updated security rules** — they now include the
> `linkCodes` / `modDex` / `mcLinks` blocks this feature needs).
>
> The backend only runs on **Vercel** (GitHub Pages is static-only and can't host
> functions). The site stays fine on either host; the *Live server sync* buttons
> just won't work on the Pages copy.

---

## 1. Create a Firebase service account

The backend needs admin credentials (different from the public web config).

1. [Firebase console](https://console.firebase.google.com) → your project →
   **⚙ Project settings → Service accounts**.
2. Click **Generate new private key** → confirm → a JSON file downloads. **Keep it
   secret** — this grants full access to your project. Do **not** commit it.

## 2. Pick a server token

Invent a long random secret (e.g. `openssl rand -hex 24`). This is the shared
password between the mod and the backend. You'll paste it in two places below.

## 3. Set Vercel environment variables

Vercel dashboard → your project → **Settings → Environment Variables**. Add (for
**Production**, and Preview if you use it):

| Name | Value |
|------|-------|
| `FIREBASE_SERVICE_ACCOUNT` | The **entire** service-account JSON from step 1. Paste it as one value. (Base64 of the JSON is also accepted if your shell mangles newlines.) |
| `SHINYDEX_SERVER_TOKEN` | The secret from step 2. |
| `SHINYDEX_SYNC_UNLINKED` | *(optional)* `true` to accept catches from players who haven't linked. Default off. |

Then **redeploy** (push a commit, or Vercel → Deployments → Redeploy) so the
functions pick up the new env vars.

> The repo now has a `package.json` (only `firebase-admin`). Vercel installs it for
> the functions automatically — keep **Build Command empty** / framework **Other**.
> The static site is unaffected.

## 4. Configure the mod

On your Minecraft server, edit `config/shinydex-link.json`:

```json
{
  "enabled": true,
  "serverId": "cobbleverse-main",
  "apiBaseUrl": "https://<your-project>.vercel.app/api",
  "serverToken": "<the same secret from step 2>",
  ...
}
```

- `apiBaseUrl` **must end in `/api`** — the mod appends `/minecraft/link/verify`
  etc., and Vercel serves the functions under `/api/...`.
- `serverToken` must exactly match `SHINYDEX_SERVER_TOKEN`.

Restart the server. Verify connectivity in-game with `/shinydex test` — it hits
`/api/minecraft/test-event` and should report success **without** changing any dex.

## 5. Link your account (each player, once)

1. On the website: sign in (Account & cloud sync), open **Data → Minecraft mod sync
   → Live server sync**, click **Generate link code**.
2. In Minecraft within 15 min: `/shinydex link <code>`.
3. Done. New catches now flow automatically; the site merges them on sign-in/refresh,
   and **Sync now** pulls on demand. `/shinydex unlink` stops it.

---

## What gets stored in Firestore

| Collection | Doc id | Written by | Read by |
|-----------|--------|-----------|---------|
| `linkCodes` | the code | website (client) | backend (burns it) |
| `mcLinks` | Minecraft UUID | backend | backend |
| `modDex` | user uid | backend (catches) + website owner (corrections) | website (owner) |
| `modBerries` | user uid | backend (adds) + website owner (removals) | website (owner) |
| `modHunts` | user uid | backend (hunt sync on disconnect) | backend (hunt fetch on start) + website (mirrors into Active hunts) |

`modDex/{uid}.dex` is a plain `{ "<nationalDex>": "caught" | "shiny" }` map. The
backend only ever *adds/upgrades* it; the merge-up into your normal progress is
upgrade-only, so a manual ✨/📦 is never overwritten by the mod. The website also
writes it in one case — **Push site changes** reconciles owner-side removals/downgrades
(e.g. an evolved Pokémon) back down, so the upgrade-only pull can't resurrect them.

`modHunts/{uid}.hunts` is a `{ "<species>|<form>": { encounters, eggs, manual, total,
... } }` map of a player's **in-progress** shiny hunts (form blank for an any-form
hunt). Unlike the dex, this is **replace-only**: each disconnect overwrites the whole
map with the mod's current snapshot, so a stopped/finished hunt disappears.

On pull, the website mirrors these into its own Hunt tab "Active hunts" (`state.hunt.sessions`):
species→dex, form→variant, eggs-heavy→breeding else encounter, `total`→the session count.
The count is upgrade-only (never lowers a hand-tracked tally) and mod-mirrored sessions
are pruned when they leave the snapshot — so the site's hunt count tracks what you synced.

## Endpoints (implemented in `api/minecraft/`)

| Mod call | Function |
|----------|----------|
| `POST /minecraft/link/verify` | `api/minecraft/link/verify.js` |
| `POST /minecraft/unlink` | `api/minecraft/unlink.js` |
| `POST /minecraft/catches` | `api/minecraft/catches.js` |
| `POST /minecraft/berries` | `api/minecraft/berries.js` |
| `POST /minecraft/test-event` | `api/minecraft/test-event.js` |
| `POST /minecraft/hunts/sync` | `api/minecraft/hunts/sync.js` |
| `POST /minecraft/hunts/fetch` | `api/minecraft/hunts/fetch.js` |

`/minecraft/berries` takes `{ serverToken, minecraftUuid, berries: [...] }` (or a
single `berry`). Ids may be bare (`occa`) or full item ids (`cobblemon:occa_berry`);
unknown ids are ignored. Berries are a set-only collection, so the scan is idempotent.

`/minecraft/hunts/sync` takes `{ serverToken, minecraftUuid, hunts: [...] }` — the
mod's full hunt snapshot, sent when a player disconnects — and replaces `modHunts/{uid}`
with it. `/minecraft/hunts/fetch` takes `{ serverToken, minecraftUuid, species, form? }`
and returns `{ found, hunt }` so a hunt resumes its counter when it restarts. Both key
hunts by `species|form` (the mod's key) and no-op for unlinked players. See
`shiny-dex-site-link/docs/backend-api.md` for the exact request/response shapes.

All require the matching `serverToken`; catches/links resolve species by name or
national-dex number via `js/data/species.json`.

`/minecraft/catches` also reads the catch's Cobblemon `aspects` (e.g. `["alolan"]`,
`["region-bias-alola"]`, with `form` as a fallback) and matches them against
`js/data/variants.json` (`api/_lib/variants.js`) to update the player's **Variants**
tab — stored as `variants:{<variantId>:"caught"|"shiny"}` on `modDex/{uid}` alongside
the national dex. Variants are upgrade-only and have only caught/shiny states (no
seen/boxed). Plain forms and unknown variants just update the national dex as before.

## Troubleshooting

- **`Invalid server token`** → `SHINYDEX_SERVER_TOKEN` (Vercel) ≠ `serverToken` (mod),
  or you didn't redeploy after setting the env var.
- **`FIREBASE_SERVICE_ACCOUNT ... not valid JSON`** → the JSON got truncated/mangled
  when pasted; try base64-encoding the file and pasting that instead.
- **`Player not linked`** on catches → run the link flow (step 5), or set
  `SHINYDEX_SYNC_UNLINKED=true`.
- **Catches succeed but the site doesn't update** → refresh / click **Sync now**;
  confirm the security rules from SETUP-CLOUD.md were **published**.
- **Buttons say "Cloud sync isn't configured"** → finish SETUP-CLOUD.md first.
