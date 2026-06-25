/* POST /api/minecraft/catches
 * Apply one catch to the linked user's mod-sourced dex (modDex/{uid}). The merge
 * is upgrade-only (caught < shiny), so re-sends are naturally idempotent — a
 * repeat is reported as duplicate:false-of-change (no upgrade) without erroring.
 */
const { db } = require("../_lib/admin");
const { readBody, tokenOk, truthy } = require("../_lib/http");
const { resolveDex } = require("../_lib/species");
const { resolveVariant } = require("../_lib/variants");

const RANK = { seen: 1, caught: 2, shiny: 3 };
// Variants only have caught/shiny (no seen, no boxed) — see js/app.js Variants tab.
const VRANK = { caught: 2, shiny: 3 };
const noChange = {
  normalCaught: false, shinyCaught: false, newDexEntry: false,
  variantId: null, variantCaught: false, variantShinyCaught: false,
};

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ success: false, message: "Method not allowed" });
  const body = await readBody(req);
  if (!tokenOk(body)) return res.status(401).json({ success: false, message: "Invalid server token" });

  const { minecraftUuid } = body;
  const shiny = truthy(body.shiny);
  if (!minecraftUuid) return res.status(400).json({ success: false, message: "Missing minecraftUuid" });

  const dex = resolveDex(body);
  if (!dex) {
    return res.status(200).json({ success: true, duplicate: false, message: "Unknown species, ignored", updated: noChange });
  }

  let linkSnap;
  try { linkSnap = await db.collection("mcLinks").doc(String(minecraftUuid)).get(); }
  catch (e) { console.error("catches link lookup", e); return res.status(500).json({ success: false, message: "Server error" }); }

  const link = linkSnap.exists ? linkSnap.data() : null;
  const allowUnlinked = String(process.env.SHINYDEX_SYNC_UNLINKED || "") === "true";
  if (!link || (link.linked !== true && !allowUnlinked) || !link.uid) {
    return res.status(200).json({ success: true, duplicate: false, message: "Player not linked", updated: noChange });
  }
  const uid = link.uid;
  const next = shiny ? "shiny" : "caught";
  // A regional/cosmetic/cobblemon form (matched on aspects/form) also updates the
  // separate Variants tab. null when the catch is a plain form or unknown variant.
  const variant = resolveVariant(dex, body);
  const ref = db.collection("modDex").doc(uid);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : {};
      const map = Object.assign({}, data.dex || {});
      const key = String(dex);
      const cur = map[key];
      const newDexEntry = !cur;
      const upgraded = !cur || RANK[next] > (RANK[cur] || 0);
      if (upgraded) map[key] = next;

      const write = {
        dex: map, updatedAt: Date.now(), lastSyncAt: Date.now(),
        minecraftName: body.minecraftName || data.minecraftName || null,
      };
      let variantUpgraded = false;
      if (variant) {
        const variants = Object.assign({}, data.variants || {});
        const vcur = variants[variant.id];
        variantUpgraded = !vcur || VRANK[next] > (VRANK[vcur] || 0);
        if (variantUpgraded) variants[variant.id] = next;
        write.variants = variants;
      }
      tx.set(ref, write, { merge: true });
      return { upgraded, newDexEntry, variantUpgraded };
    });
    db.collection("mcLinks").doc(String(minecraftUuid)).set({ lastSyncAt: Date.now() }, { merge: true }).catch(() => {});
    return res.status(200).json({
      success: true,
      duplicate: !result.upgraded && !result.variantUpgraded,
      message: "OK",
      updated: {
        normalCaught: true,
        shinyCaught: next === "shiny",
        newDexEntry: result.newDexEntry,
        variantId: variant ? variant.id : null,
        variantCaught: !!variant,
        variantShinyCaught: !!variant && next === "shiny",
      },
    });
  } catch (e) {
    console.error("catches write error", e);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
