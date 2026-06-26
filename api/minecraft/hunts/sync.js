/* POST /api/minecraft/hunts/sync
 * Persist a linked player's active shiny hunts. The mod sends this when the player
 * disconnects, with `hunts` as a FULL, AUTHORITATIVE snapshot — we replace whatever
 * was stored for them (an empty list clears it, e.g. they stopped/finished all hunts).
 * Hunts are keyed by `species|form` so /hunts/fetch can resume one when it restarts.
 */
const { db } = require("../../_lib/admin");
const { readBody, tokenOk } = require("../../_lib/http");
const { huntKey, sanitizeHunt } = require("../../_lib/hunts");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ success: false, message: "Method not allowed" });
  const body = await readBody(req);
  if (!tokenOk(body)) return res.status(401).json({ success: false, message: "Invalid server token" });

  const { minecraftUuid } = body;
  if (!minecraftUuid) return res.status(400).json({ success: false, message: "Missing minecraftUuid" });

  // Build the new authoritative hunt map from the snapshot. Later duplicates of the
  // same species|form win (the mod won't send dupes, but be deterministic anyway).
  const rawHunts = Array.isArray(body.hunts) ? body.hunts : [];
  const map = {};
  for (const raw of rawHunts) {
    const hunt = sanitizeHunt(raw);
    if (hunt) map[huntKey(hunt.species, hunt.form)] = hunt;
  }

  let linkSnap;
  try { linkSnap = await db.collection("mcLinks").doc(String(minecraftUuid)).get(); }
  catch (e) { console.error("hunts/sync link lookup", e); return res.status(500).json({ success: false, message: "Server error" }); }

  const link = linkSnap.exists ? linkSnap.data() : null;
  const allowUnlinked = String(process.env.SHINYDEX_SYNC_UNLINKED || "") === "true";
  if (!link || (link.linked !== true && !allowUnlinked) || !link.uid) {
    return res.status(200).json({ success: true, message: "Player not linked", stored: 0 });
  }
  const uid = link.uid;
  const ref = db.collection("modHunts").doc(uid);

  try {
    // Full document set (no merge) so removed hunts actually disappear — a merged
    // map-field would keep stale keys around forever.
    await ref.set({
      hunts: map,
      updatedAt: Date.now(),
      lastSyncAt: Date.now(),
      minecraftName: body.minecraftName || null,
    });
    db.collection("mcLinks").doc(String(minecraftUuid)).set({ lastSyncAt: Date.now() }, { merge: true }).catch(() => {});
    return res.status(200).json({ success: true, message: "OK", stored: Object.keys(map).length });
  } catch (e) {
    console.error("hunts/sync write error", e);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
