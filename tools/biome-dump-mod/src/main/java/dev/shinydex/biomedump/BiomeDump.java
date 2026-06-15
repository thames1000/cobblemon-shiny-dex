package dev.shinydex.biomedump;

import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.context.CommandContext;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
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
 * Samples the server's REAL biome source at each point's surface height
 * (getUncachedNoiseBiome — no chunk generation, Biome Replacer applied),
 * so the result is exactly what the world generates. Writes a JSON the app
 * loads as an accurate biome backdrop. Example: /dumpbiomes 0 0 8192 16
 */
public class BiomeDump implements ModInitializer {
    @Override
    public void onInitialize() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registry, env) ->
            dispatcher.register(Commands.literal("dumpbiomes").requires(s -> s.hasPermission(2))
                .then(Commands.argument("centerX", IntegerArgumentType.integer())
                .then(Commands.argument("centerZ", IntegerArgumentType.integer())
                .then(Commands.argument("blocksAcross", IntegerArgumentType.integer(16, 100000))
                .then(Commands.argument("step", IntegerArgumentType.integer(1, 512))
                .executes(ctx -> dump(ctx,
                    IntegerArgumentType.getInteger(ctx, "centerX"),
                    IntegerArgumentType.getInteger(ctx, "centerZ"),
                    IntegerArgumentType.getInteger(ctx, "blocksAcross"),
                    IntegerArgumentType.getInteger(ctx, "step")))))))));
    }

    private static int dump(CommandContext<CommandSourceStack> ctx, int cx, int cz, int across, int step) {
        CommandSourceStack src = ctx.getSource();
        ServerLevel level = src.getLevel();
        ChunkGenerator gen = level.getChunkSource().getGenerator();
        RandomState rs = level.getChunkSource().randomState();

        int cols = across / step, rows = across / step;
        long cells = (long) cols * rows;
        if (cells > 4_000_000L) {
            src.sendFailure(Component.literal("Too many samples (" + cells + "). Increase step or reduce blocksAcross."));
            return 0;
        }
        src.sendSystemMessage(Component.literal("Sampling " + cols + "x" + rows + " biomes… this may take a moment."));

        List<String> palette = new ArrayList<>();
        Map<String, Integer> idx = new HashMap<>();
        int[] grid = new int[cols * rows];
        int x0 = cx - across / 2, z0 = cz - across / 2;
        for (int j = 0; j < rows; j++) {
            for (int i = 0; i < cols; i++) {
                int x = x0 + i * step, z = z0 + j * step;
                int y = gen.getBaseHeight(x, z, Heightmap.Types.WORLD_SURFACE_WG, level, rs);
                Holder<Biome> biome = level.getUncachedNoiseBiome(QuartPos.fromBlock(x), QuartPos.fromBlock(y), QuartPos.fromBlock(z));
                String id = biome.unwrapKey().map(k -> k.location().toString()).orElse("minecraft:plains");
                Integer p = idx.get(id);
                if (p == null) { p = palette.size(); idx.put(id, p); palette.add(id); }
                grid[j * cols + i] = p;
            }
        }

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
            src.sendSystemMessage(Component.literal("Wrote " + cells + " biomes (" + palette.size() + " distinct) → " + fname));
            src.sendSystemMessage(Component.literal("Load it in ShinyDex HQ → Seed Map → Load real biomes."));
        } catch (Exception e) {
            src.sendFailure(Component.literal("Write failed: " + e.getMessage()));
            return 0;
        }
        return 1;
    }
}
