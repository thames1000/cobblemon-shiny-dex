# locate-rcon — bit-exact structure positions, no mod

Drives the **vanilla `/locate`** command over **RCON** (a stock server feature,
not a mod) to get the game's own authoritative structure positions, and writes a
JSON ShinyDex HQ loads. This is the accurate alternative to the in-app deepslate
biome guess — `/locate` applies the real biome filter (incl. Biome Replacer,
elevation, cliff biomes), so the results are exactly what generates.

## 1. Enable RCON (one time)
In `server.properties` (Multicraft: **Files → Config Files → server.properties**,
or the RCON fields in the panel):
```
enable-rcon=true
rcon.password=PICK_A_PASSWORD
rcon.port=25575
```
Restart the server. The RCON port must be reachable from where you run the script:
- If your host exposes it → use the server's IP as `--host`.
- If not → run the script **on the host** (SSH) with `--host 127.0.0.1`.

## 2. Run it (needs Python 3 — no extra packages)
```
# nearest of every overworld structure from spawn (1 /locate each, fast):
python3 locate.py --host SERVER_IP --port 25575 --password PW --center 0 0

# just a few, from a point you care about:
python3 locate.py --host ... --password PW --center 3256 3320 --only ltsurge,rudi,brock

# find ALL instances within an area (slower grid sweep):
python3 locate.py --host ... --password PW --center 0 0 --sweep 8000 1200

# other dimensions:
python3 locate.py --host ... --password PW --dim nether
python3 locate.py --host ... --password PW --dim end
```
Writes `structures-located-<dim>.json`.

## 3. Load it
ShinyDex HQ → Seed Map → **📡 Load located**. The "Nearest candidates" list then
shows the **verified** (`/locate`) positions for those structures instead of the
deepslate guess.

Notes:
- **nearest** mode records the nearest instance from `--center`; re-run with the
  same center you scan from in the app for a true "nearest".
- **sweep** mode records every instance in the area (re-sortable from any point).
- `/locate` for very rare structures (e.g. blooming_plateau ones) can take a
  second or two each — that's the server searching, and it's exact.
