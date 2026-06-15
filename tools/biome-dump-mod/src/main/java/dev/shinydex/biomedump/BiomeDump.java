package dev.shinydex.biomedump;

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

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Server-side biome export for ShinyDex HQ's seed map.
 *
 * /dumpbiomes <centerX> <centerZ> <blocksAcross> <step>
 *
 * Samples the server's REAL biome source at each point's true surface height
 * (getBaseHeight + getUncachedNoiseBiome — Biome Replacer applied, no chunk
 * generation), so the result is exactly what the world generates.
 *
 * getBaseHeight samples a full noise column, so 512x512 = 262k of them in one
 * tick blows the 60s watchdog and crashes the server. So the dump runs as a
 * JOB spread across server ticks with a ~25ms/tick budget: the server stays up
 * (mild lag for a few minutes), then writes a JSON the app loads as an accurate
 * biome backdrop. Example: /dumpbiomes 0 0 8192 16
 */
public class BiomeDump implements ModInitializer {
    /** At most one dump runs at a time; the tick handler drives it. */
    private static Job job = null;

    @Override
    public void onInitialize() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registry, env) ->
            dispatcher.register(Commands.literal("dumpbiomes").requires(s -> s.hasPermission(2))
                .then(Commands.argument("centerX", IntegerArgumentType.integer())
                .then(Commands.argument("centerZ", IntegerArgumentType.integer())
                .then(Commands.argument("blocksAcross", IntegerArgumentType.integer(16, 100000))
                .then(Commands.argument("step", IntegerArgumentType.integer(1, 512))
                .executes(ctx -> start(ctx,
                    IntegerArgumentType.getInteger(ctx, "centerX"),
                    IntegerArgumentType.getInteger(ctx, "centerZ"),
                    IntegerArgumentType.getInteger(ctx, "blocksAcross"),
                    IntegerArgumentType.getInteger(ctx, "step")))))))));

        // Drive the active job a little each tick so no single tick runs long.
        ServerTickEvents.END_SERVER_TICK.register(server -> { if (job != null) job.tick(); });
    }

    private static int start(CommandContext<CommandSourceStack> ctx, int cx, int cz, int across, int step) {
        CommandSourceStack src = ctx.getSource();
        if (job != null) {
            src.sendFailure(Component.literal("A biome dump is already running (" + job.pct() + "%). Wait for it to finish."));
            return 0;
        }
        int cols = across / step, rows = across / step;
        long cells = (long) cols * rows;
        if (cells > 4_000_000L) {
            src.sendFailure(Component.literal("Too many samples (" + cells + "). Increase step or reduce blocksAcross."));
            return 0;
        }
        job = new Job(src, src.getLevel(), cx, cz, across, step, cols, rows);
        // Rough ETA: ~2ms wall per sample with this generator (heavy Terralith graph).
        long etaSec = cells * 2L / 1000L;
        src.sendSystemMessage(Component.literal(
            "Sampling " + cols + "x" + rows + " (" + cells + ") biomes across multiple ticks (~"
            + (etaSec < 90 ? etaSec + "s" : (etaSec / 60) + " min") + "). "
            + "Expect mild lag; you'll get progress updates and a final message."));
        return 1;
    }

    /** A running dump, advanced incrementally by the server-tick handler. */
    static final class Job {
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

        Job(CommandSourceStack src, ServerLevel level, int cx, int cz, int across, int step, int cols, int rows) {
            this.src = src; this.level = level;
            this.gen = level.getChunkSource().getGenerator();
            this.rs = level.getChunkSource().randomState();
            this.cx = cx; this.cz = cz; this.across = across; this.step = step;
            this.cols = cols; this.rows = rows;
            this.x0 = cx - across / 2; this.z0 = cz - across / 2;
            this.grid = new int[cols * rows];
            this.total = (long) cols * rows;
        }

        int pct() { return (int) (n * 100 / total); }

        void tick() {
            // getBaseHeight builds a whole ChunkNoiseSampler + runs Terralith's huge
            // density graph each call (~1-2ms, high variance). So check the time budget
            // EVERY cell — a clock read is ~nanoseconds. Cap each tick at ~40ms so a tick
            // never approaches the 60s watchdog, while still making decent progress.
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
            int bucket = pct() / 10;
            if (bucket != lastBucket) { lastBucket = bucket; say("…biome dump " + pct() + "%"); }
            if (n >= total) finish();
        }

        private void finish() {
            job = null; // stop being ticked, even if writing fails
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

        /** Progress/result messages; never let a gone player abort the dump. */
        private void say(String msg) {
            try { src.sendSystemMessage(Component.literal(msg)); } catch (Exception ignored) {}
        }
    }
}
