package dev.shinydex.biomedump;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.context.CommandContext;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.core.Holder;
import net.minecraft.core.QuartPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.chunk.ChunkGenerator;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.levelgen.RandomState;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/**
 * Server-side biome / structure export for ShinyDex HQ's seed map.
 *
 * Two commands, both spread across server ticks (~40ms/tick, time checked every
 * sample) so they never trip the 60s watchdog:
 *
 *   /probestructures <centerX> <centerZ> <radius>   (recommended)
 *       Computes each structure's candidate chunks with the SAME random_spread
 *       math the app uses (java.util.Random == Minecraft's LegacyRandomSource),
 *       seeded from the server's real level seed, then samples the REAL biome at
 *       each candidate. Writes only those points (a few hundred-few thousand,
 *       not 262k), so it's fast. The app uses this to mark candidates valid/dim
 *       from authoritative biomes while keeping deepslate as the backdrop.
 *
 *   /dumpbiomes <centerX> <centerZ> <blocksAcross> <step>
 *       Full biome grid (slow: every cell runs the generator). Kept for a fully
 *       accurate visual backdrop if you want one.
 */
public class BiomeDump implements ModInitializer {
    /** A unit of work advanced each tick; returns true once finished. */
    private interface Job { boolean tick(); }
    private static Job job;

    @Override
    public void onInitialize() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registry, env) -> {
            dispatcher.register(Commands.literal("dumpbiomes").requires(s -> s.hasPermission(2))
                .then(Commands.argument("centerX", IntegerArgumentType.integer())
                .then(Commands.argument("centerZ", IntegerArgumentType.integer())
                .then(Commands.argument("blocksAcross", IntegerArgumentType.integer(16, 100000))
                .then(Commands.argument("step", IntegerArgumentType.integer(1, 512))
                .executes(ctx -> startGrid(ctx,
                    IntegerArgumentType.getInteger(ctx, "centerX"),
                    IntegerArgumentType.getInteger(ctx, "centerZ"),
                    IntegerArgumentType.getInteger(ctx, "blocksAcross"),
                    IntegerArgumentType.getInteger(ctx, "step"))))))));

            dispatcher.register(Commands.literal("probestructures").requires(s -> s.hasPermission(2))
                .then(Commands.argument("centerX", IntegerArgumentType.integer())
                .then(Commands.argument("centerZ", IntegerArgumentType.integer())
                .then(Commands.argument("radius", IntegerArgumentType.integer(16, 5_000_000))
                .executes(ctx -> startProbe(ctx,
                    IntegerArgumentType.getInteger(ctx, "centerX"),
                    IntegerArgumentType.getInteger(ctx, "centerZ"),
                    IntegerArgumentType.getInteger(ctx, "radius")))))));
        });

        ServerTickEvents.END_SERVER_TICK.register(server -> { if (job != null && job.tick()) job = null; });
    }

    private static String etaText(long cells) {
        long s = cells * 2L / 1000L; // ~2ms wall per sample with this generator
        return s < 90 ? s + "s" : (s / 60) + " min";
    }

    // ───────────────────────────── structure probe ─────────────────────────────

    private static int startProbe(CommandContext<CommandSourceStack> ctx, int cx, int cz, int radius) {
        CommandSourceStack src = ctx.getSource();
        if (job != null) { src.sendFailure(Component.literal("A dump/probe is already running. Wait for it to finish.")); return 0; }
        ProbeJob pj;
        try {
            pj = new ProbeJob(src, src.getLevel(), cx, cz, radius);
        } catch (Exception e) {
            src.sendFailure(Component.literal("Probe setup failed: " + e.getMessage()));
            return 0;
        }
        if (pj.count() == 0) {
            src.sendFailure(Component.literal("No structure candidates within " + radius
                + " of (" + cx + ", " + cz + ") in this dimension. Try a bigger radius."));
            return 0;
        }
        job = pj;
        src.sendSystemMessage(Component.literal(
            "Probing " + pj.count() + " structure candidate points (~" + etaText(pj.count())
            + "). The map's structure markers will be biome-accurate."));
        return 1;
    }

    static final class ProbeJob implements Job {
        private final CommandSourceStack src;
        private final ServerLevel level;
        private final ChunkGenerator gen;
        private final RandomState randomState;
        private final long seed;
        private final int cx, cz, radius;
        private final String[] keys;     // "centerX,centerZ" — how the app keys candidates
        private final int[][] samples;   // {sampleX, sampleZ} (chunk corner, what /locate reports)
        private final String[] biomes;   // filled across ticks
        private long n = 0;
        private int lastBucket = -1;

        ProbeJob(CommandSourceStack src, ServerLevel level, int cx, int cz, int radius) throws Exception {
            this.src = src; this.level = level;
            this.gen = level.getChunkSource().getGenerator();
            this.randomState = level.getChunkSource().randomState();
            this.seed = level.getSeed();
            this.cx = cx; this.cz = cz; this.radius = radius;

            String dimKey = toDimKey(level.dimension().location().getPath());
            // Dedup candidate points by their center coord (different structures can
            // theoretically collide; the biome there is the same regardless).
            LinkedHashMap<String, int[]> uniq = new LinkedHashMap<>();
            int ccx = Math.floorDiv(cx, 16), ccz = Math.floorDiv(cz, 16);
            int rChunks = (int) Math.ceil(radius / 16.0);
            for (StructDef sd : loadStructures()) {
                if (!sd.dim.equals(dimKey)) continue;
                int cReg = Math.floorDiv(ccx, sd.spacing), cRegZ = Math.floorDiv(ccz, sd.spacing);
                int rr = (int) Math.ceil((double) rChunks / sd.spacing) + 1;
                for (int rx = cReg - rr; rx <= cReg + rr; rx++) {
                    for (int rz = cRegZ - rr; rz <= cRegZ + rr; rz++) {
                        int[] ch = candidateChunk(seed, rx, rz, sd);
                        int bx = ch[0] * 16 + 8, bz = ch[1] * 16 + 8;
                        if (Math.hypot(bx - cx, bz - cz) <= radius) {
                            String key = bx + "," + bz;
                            uniq.putIfAbsent(key, new int[]{bx - 8, bz - 8});
                        }
                    }
                }
            }
            this.keys = uniq.keySet().toArray(new String[0]);
            this.samples = uniq.values().toArray(new int[0][]);
            this.biomes = new String[keys.length];
        }

        int count() { return keys.length; }

        @Override
        public boolean tick() {
            final long budgetNs = 40_000_000L;
            final long startNs = System.nanoTime();
            while (n < keys.length) {
                if (System.nanoTime() - startNs > budgetNs) break;
                int[] s = samples[(int) n];
                int y = gen.getBaseHeight(s[0], s[1], Heightmap.Types.WORLD_SURFACE_WG, level, randomState);
                Holder<Biome> biome = level.getUncachedNoiseBiome(
                    QuartPos.fromBlock(s[0]), QuartPos.fromBlock(y), QuartPos.fromBlock(s[1]));
                biomes[(int) n] = biome.unwrapKey().map(k -> k.location().toString()).orElse("minecraft:plains");
                n++;
            }
            int bucket = (int) (n * 10 / keys.length);
            if (bucket != lastBucket) { lastBucket = bucket; say("…structure probe " + (n * 100 / keys.length) + "%"); }
            if (n >= keys.length) { finish(); return true; }
            return false;
        }

        private void finish() {
            StringBuilder sb = new StringBuilder(keys.length * 40 + 256);
            sb.append("{\"dimension\":\"").append(level.dimension().location()).append("\"")
              .append(",\"seed\":").append(seed)
              .append(",\"centerX\":").append(cx).append(",\"centerZ\":").append(cz)
              .append(",\"radius\":").append(radius)
              .append(",\"points\":{");
            for (int i = 0; i < keys.length; i++) {
                if (i > 0) sb.append(',');
                sb.append('"').append(keys[i]).append("\":\"").append(biomes[i]).append('"');
            }
            sb.append("}}");

            String dim = level.dimension().location().getPath();
            String fname = "probe-" + dim + "-" + cx + "_" + cz + "-r" + radius + ".json";
            try {
                Path out = level.getServer().getServerDirectory().resolve(fname);
                Files.writeString(out, sb.toString());
                say("Wrote " + keys.length + " candidate biomes → " + fname);
                say("Load it in ShinyDex HQ → Seed Map → Load probe.");
            } catch (Exception e) {
                say("Write failed: " + e.getMessage());
            }
        }

        private void say(String msg) {
            try { src.sendSystemMessage(Component.literal(msg)); } catch (Exception ignored) {}
        }
    }

    /** The candidate chunk a random_spread structure_set tries to place in region (rx,rz). */
    private static int[] candidateChunk(long seed, int rx, int rz, StructDef sd) {
        int d = sd.spacing - sd.separation;
        // setLargeFeatureWithSalt: java.util.Random(seed) scrambles identically to MC's
        // LegacyRandomSource, so this matches /locate exactly (validated against the server).
        long regionSeed = rx * 341873128712L + rz * 132897987541L + seed + sd.salt;
        Random r = new Random(regionSeed);
        int ox, oz;
        if (sd.triangular) {
            ox = (r.nextInt(d) + r.nextInt(d)) / 2;
            oz = (r.nextInt(d) + r.nextInt(d)) / 2;
        } else {
            ox = r.nextInt(d);
            oz = r.nextInt(d);
        }
        return new int[]{rx * sd.spacing + ox, rz * sd.spacing + oz};
    }

    private static String toDimKey(String path) {
        if ("the_nether".equals(path)) return "nether";
        if ("the_end".equals(path)) return "end";
        return "overworld";
    }

    // Bundled copy of the app's structure list; parsed once.
    private static List<StructDef> structs;
    private static synchronized List<StructDef> loadStructures() throws Exception {
        if (structs != null) return structs;
        try (InputStream in = BiomeDump.class.getResourceAsStream("/structures.json")) {
            if (in == null) throw new IllegalStateException("structures.json missing from the mod jar");
            String txt = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            JsonArray arr = JsonParser.parseString(txt).getAsJsonArray();
            List<StructDef> list = new ArrayList<>();
            for (JsonElement el : arr) {
                JsonObject o = el.getAsJsonObject();
                if (!o.has("spacing") || !o.has("separation") || !o.has("salt")) continue;
                StructDef sd = new StructDef();
                sd.dim = o.has("dim") ? o.get("dim").getAsString() : "overworld";
                sd.spacing = o.get("spacing").getAsInt();
                sd.separation = o.get("separation").getAsInt();
                sd.salt = o.get("salt").getAsLong();
                sd.triangular = o.has("spread") && "triangular".equals(o.get("spread").getAsString());
                if (sd.spacing > 0 && sd.separation >= 0 && sd.separation < sd.spacing) list.add(sd);
            }
            structs = list;
        }
        return structs;
    }

    private static final class StructDef {
        String dim;
        int spacing, separation;
        long salt;
        boolean triangular;
    }

    // ───────────────────────────── full biome grid ─────────────────────────────

    private static int startGrid(CommandContext<CommandSourceStack> ctx, int cx, int cz, int across, int step) {
        CommandSourceStack src = ctx.getSource();
        if (job != null) { src.sendFailure(Component.literal("A dump/probe is already running. Wait for it to finish.")); return 0; }
        int cols = across / step, rows = across / step;
        long cells = (long) cols * rows;
        if (cells > 4_000_000L) {
            src.sendFailure(Component.literal("Too many samples (" + cells + "). Increase step or reduce blocksAcross."));
            return 0;
        }
        job = new GridJob(src, src.getLevel(), cx, cz, across, step, cols, rows);
        src.sendSystemMessage(Component.literal(
            "Sampling " + cols + "x" + rows + " (" + cells + ") biomes across multiple ticks (~"
            + etaText(cells) + "). Expect mild lag; you'll get progress and a final message."));
        return 1;
    }

    static final class GridJob implements Job {
        private final CommandSourceStack src;
        private final ServerLevel level;
        private final ChunkGenerator gen;
        private final RandomState rs;
        private final int cx, cz, step, cols, rows, across, x0, z0;
        private final int[] grid;
        private final List<String> palette = new ArrayList<>();
        private final Map<String, Integer> idx = new HashMap<>();
        private final long total;
        private long n = 0;
        private int lastBucket = -1;

        GridJob(CommandSourceStack src, ServerLevel level, int cx, int cz, int across, int step, int cols, int rows) {
            this.src = src; this.level = level;
            this.gen = level.getChunkSource().getGenerator();
            this.rs = level.getChunkSource().randomState();
            this.cx = cx; this.cz = cz; this.across = across; this.step = step;
            this.cols = cols; this.rows = rows;
            this.x0 = cx - across / 2; this.z0 = cz - across / 2;
            this.grid = new int[cols * rows];
            this.total = (long) cols * rows;
        }

        @Override
        public boolean tick() {
            final long budgetNs = 40_000_000L;
            final long startNs = System.nanoTime();
            while (n < total) {
                if (System.nanoTime() - startNs > budgetNs) break;
                int i = (int) (n % cols), j = (int) (n / cols);
                int x = x0 + i * step, z = z0 + j * step;
                int y = gen.getBaseHeight(x, z, Heightmap.Types.WORLD_SURFACE_WG, level, rs);
                Holder<Biome> biome = level.getUncachedNoiseBiome(
                    QuartPos.fromBlock(x), QuartPos.fromBlock(y), QuartPos.fromBlock(z));
                String id = biome.unwrapKey().map(k -> k.location().toString()).orElse("minecraft:plains");
                Integer p = idx.get(id);
                if (p == null) { p = palette.size(); idx.put(id, p); palette.add(id); }
                grid[(int) n] = p;
                n++;
            }
            int bucket = (int) (n * 10 / total);
            if (bucket != lastBucket) { lastBucket = bucket; say("…biome dump " + (int) (n * 100 / total) + "%"); }
            if (n >= total) { finish(); return true; }
            return false;
        }

        private void finish() {
            StringBuilder sb = new StringBuilder(grid.length * 3 + 1024);
            sb.append("{\"dimension\":\"").append(level.dimension().location()).append("\"")
              .append(",\"centerX\":").append(cx).append(",\"centerZ\":").append(cz)
              .append(",\"step\":").append(step).append(",\"cols\":").append(cols).append(",\"rows\":").append(rows)
              .append(",\"palette\":[");
            for (int i = 0; i < palette.size(); i++) { if (i > 0) sb.append(','); sb.append('"').append(palette.get(i)).append('"'); }
            sb.append("],\"grid\":[");
            for (int i = 0; i < grid.length; i++) { if (i > 0) sb.append(','); sb.append(grid[i]); }
            sb.append("]}");

            String dim = level.dimension().location().getPath();
            String fname = "biome-dump-" + dim + "-" + cx + "_" + cz + "-" + across + "-s" + step + ".json";
            try {
                Path out = level.getServer().getServerDirectory().resolve(fname);
                Files.writeString(out, sb.toString());
                say("Wrote " + total + " biomes (" + palette.size() + " distinct) → " + fname);
                say("Load it in ShinyDex HQ → Seed Map → Load real biomes.");
            } catch (Exception e) {
                say("Write failed: " + e.getMessage());
            }
        }

        private void say(String msg) {
            try { src.sendSystemMessage(Component.literal(msg)); } catch (Exception ignored) {}
        }
    }
}
