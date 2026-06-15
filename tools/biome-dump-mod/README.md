# Biome Dump — server-side biome/structure export for ShinyDex HQ

Exports your server's **real** biomes (the actual generator + Biome Replacer)
so the seed map is accurate, not a reimplementation. Two commands:

- **`/probestructures <centerX> <centerZ> <radius>`** — *recommended.* Computes
  every structure's candidate chunks itself (same `random_spread` math the app
  uses, seeded from the server's real seed) and samples the real biome **only at
  those candidates** — a few hundred–few thousand points, so it's fast. The app
  loads the result to mark structure markers valid/dim from authoritative biomes,
  while deepslate stays the visual backdrop. This is the accurate, cheap way to
  fix structure validation (e.g. Jirachi) without a full grid dump.
- **`/dumpbiomes <centerX> <centerZ> <blocksAcross> <step>`** — full biome grid
  for a 100%-accurate *visual* backdrop. Slow (every cell runs the generator).

Both run across server ticks (~40ms/tick, time checked every sample) so they
never trip the 60s watchdog.

## Probe (recommended)
1. Put the jar in `mods/` and restart.
2. In console / as op (target the dimension for nether/end):
   ```
   probestructures 0 0 20000
   ```
   It writes `probe-overworld-0_0-r20000.json` to the server directory after a
   few seconds (it prints progress + a final "Wrote N candidate biomes").
3. In ShinyDex HQ → Seed Map → **🎯 Load probe**. Structure markers within the
   radius now show solid (valid biome) or dim (wrong biome) from the real server.
   The probe also carries the server seed and auto-aligns the map's seed field.

## Build
Needs **JDK 21**. Use the bundled Gradle wrapper (do NOT use your system
`gradle` — it's too old for modern JDKs):
```
./gradlew build        # Windows: gradlew.bat build
```
First run downloads Gradle 8.10.2 automatically. The jar lands in
`build/libs/biome-dump-1.0.0.jar`.

If `./gradlew` reports the wrong Java version, point it at JDK 21:
`./gradlew build -Dorg.gradle.java.home=/path/to/jdk-21`

## Use
1. Put the jar in your server's `mods/` folder and restart.
2. In console / as an op, run (center X, center Z, blocks across, blocks per sample):
   ```
   dumpbiomes 0 0 8192 16
   ```
   - `8192` across at `16`/sample = a 512×512 grid (8 km² around 0,0).
   - Bigger area or finer detail = more samples (cap ~4M). Start coarse.
   - The dump runs **across many server ticks** (a ~40ms/tick budget, time
     checked every sample), so it never trips the watchdog. It prints an ETA,
     then `…biome dump 10%…20%…`, then "Wrote N biomes".
   - It's **slow** because each sample runs the full Terralith generator
     (~2ms each): a 512×512 dump is ~8–10 min of mild lag. **Test small first**
     (`dumpbiomes 0 0 1024 16` ≈ a few seconds) to confirm it writes/loads,
     then run the big one. Coarser `step` (e.g. `24`/`32`) is much faster.
   - For the nether / end, target that dimension:
     ```
     execute in minecraft:the_nether run dumpbiomes 0 0 4096 16
     execute in minecraft:the_end    run dumpbiomes 0 0 8192 16
     ```
3. It writes `biome-dump-overworld-0_0-8192-s16.json` to the server directory.
4. In ShinyDex HQ → **Seed Map → Load real biomes**, pick that file. The map
   redraws with exact biomes and structures validate against them.

It samples the real generator's surface height (`getBaseHeight`) and the real
biome source (`getUncachedNoiseBiome`, Biome Replacer applied) at each point —
no chunk generation, so it doesn't bloat your world. `getBaseHeight` is the
expensive part, which is why the work is spread across ticks.
