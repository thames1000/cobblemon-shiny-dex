/* POST /api/minecraft/hunts/sync
 * Persist a linked player's shiny hunts. The mod sends this when the player
 * disconnects, with `hunts` as the full snapshot of their CURRENTLY ACTIVE hunts.
 *
 * We keep a history: modHunts/{uid} holds an `active` map and an `inactive` map, both
 * keyed by `species|form`. The snapshot becomes `active`; any hunt that was active but
 * is no longer in the snapshot (stopped or finished in-game) is MOVED to `inactive`
 * with its last counts — never dropped — so a later /hunts/fetch can resume it. A hunt
 * that reappears in the snapshot is promoted back out of `inactive`.
 */
const { db } = require("../../_lib/admin");
const { readBody, tokenOk } = require("../../_lib/http");
const { huntKey, sanitizeHunt, readBuckets, markInactive } = require("../../_lib/hunts");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ success: false, message: "Method not allowed" });
  const body = await readBody(req);
  if (!tokenOk(body)) return res.status(401).json({ success: false, message: "Invalid server token" });

  const { minecraftUuid } = body;
  if (!minecraftUuid) return res.status(400).json({ success: false, message: "Missing minecraftUuid" });

  // The active snapshot. Later duplicates of the same species|form win (the mod won't
  // send dupes, but be deterministic anyway).
  const rawHunts = Array.isArray(body.hunts) ? body.hunts : [];
  const newActive = {};
  for (const raw of rawHunts) {
    const hunt = sanitizeHunt(raw);
    if (hunt) newActive[huntKey(hunt.species, hunt.form)] = hunt;
  }

  let linkSnap;
  try { linkSnap = await db.collection("mcLinks").doc(String(minecraftUuid)).get(); }
  catch (e) { console.error("hunts/sync link lookup", e); return res.status(500).json({ success: false, message: "Server error" }); }

  const link = linkSnap.exists ? linkSnap.data() : null;
  const allowUnlinked = String(process.env.SHINYDEX_SYNC_UNLINKED || "") === "true";
  if (!link || (link.linked !== true && !allowUnlinked) || !link.uid) {
    return res.status(200).json({ success: true, message: "Player not linked", stored: 0, archived: 0 });
  }
  const uid = link.uid;
  const ref = db.collection("modHunts").doc(uid);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const { active: oldActive, inactive: oldInactive } = readBuckets(snap.exists ? snap.data() : null);
      const now = Date.now();

      const newInactive = Object.assign({}, oldInactive);
      // Demote hunts that fell out of the active snapshot (stopped/finished), keeping
      // their last-known counts so they can be resumed later.
      for (const [k, hunt] of Object.entries(oldActive)) {
        if (!(k in newActive)) newInactive[k] = markInactive(hunt, now);
      }
      // A hunt that's active again must not also linger in inactive.
      for (const k of Object.keys(newActive)) delete newInactive[k];

      // Full set (no merge) so the doc holds exactly these buckets — this also migrates
      // any legacy flat `hunts` field away.
      tx.set(ref, {
        active: newActive,
        inactive: newInactive,
        updatedAt: now,
        lastSyncAt: now,
        minecraftName: body.minecraftName || null,
      });
      return { stored: Object.keys(newActive).length, archived: Object.keys(newInactive).length };
    });
    db.collection("mcLinks").doc(String(minecraftUuid)).set({ lastSyncAt: Date.now() }, { merge: true }).catch(() => {});
    return res.status(200).json({ success: true, message: "OK", stored: result.stored, archived: result.archived });
  } catch (e) {
    console.error("hunts/sync write error", e);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
