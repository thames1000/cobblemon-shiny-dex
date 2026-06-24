/* POST /api/minecraft/catches
 * Apply one catch to the linked user's mod-sourced dex (modDex/{uid}). The merge
 * is upgrade-only (caught < shiny), so re-sends are naturally idempotent — a
 * repeat is reported as duplicate:false-of-change (no upgrade) without erroring.
 */
const { db } = require("../_lib/admin");
const { readBody, tokenOk } = require("../_lib/http");
const { resolveDex } = require("../_lib/species");

const RANK = { seen: 1, caught: 2, shiny: 3 };
const noChange = { normalCaught: false, shinyCaught: false, newDexEntry: false };

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ success: false, message: "Method not allowed" });
  const body = await readBody(req);
  if (!tokenOk(body)) return res.status(401).json({ success: false, message: "Invalid server token" });

  const { minecraftUuid, shiny } = body;
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
  const next = shiny === true ? "shiny" : "caught";
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
      tx.set(ref, {
        dex: map, updatedAt: Date.now(), lastSyncAt: Date.now(),
        minecraftName: body.minecraftName || data.minecraftName || null,
      }, { merge: true });
      return { upgraded, newDexEntry };
    });
    db.collection("mcLinks").doc(String(minecraftUuid)).set({ lastSyncAt: Date.now() }, { merge: true }).catch(() => {});
    return res.status(200).json({
      success: true,
      duplicate: !result.upgraded,
      message: "OK",
      updated: { normalCaught: true, shinyCaught: next === "shiny", newDexEntry: result.newDexEntry },
    });
  } catch (e) {
    console.error("catches write error", e);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
