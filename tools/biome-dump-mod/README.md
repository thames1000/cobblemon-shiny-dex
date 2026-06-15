# Biome Dump — server-side biome export for ShinyDex HQ

Exports your server's **real** biomes (the actual generator + Biome Replacer)
so the seed-map biome layer is 100% accurate, not a reimplementation.

## Build
Needs JDK 21. From this folder:
```
gradle build      # or ./gradlew build if you add the Gradle wrapper
```
The jar lands in `build/libs/biome-dump-1.0.0.jar`.

(If you don't have Gradle: install it, or copy these files over the official
Fabric example-mod template at fabricmc.net and run its `./gradlew build`.)

## Use
1. Put the jar in your server's `mods/` folder and restart.
2. In console / as an op, run (center X, center Z, blocks across, blocks per sample):
   ```
   dumpbiomes 0 0 8192 16
   ```
   - `8192` across at `16`/sample = a 512×512 grid (8 km² around 0,0).
   - Bigger area or finer detail = more samples (cap ~4M). Start coarse.
3. It writes `biome-dump-overworld-0_0-8192-s16.json` to the server directory.
   Run it again per dimension (stand in / target the nether or end) for those.
4. In ShinyDex HQ → **Seed Map → Load real biomes**, pick that file. The map
   redraws with exact biomes and structures validate against them.

It samples `getUncachedNoiseBiome` at each point's surface height — no chunk
generation, so it's fast and doesn't bloat your world.
