/* POST /api/minecraft/berries
 * Record the berries a linked player holds. Body has minecraftUuid + either a
 * `berries` array or a single `berry`. Berries are a set-only collection ("have
 * it"), so this only ever ADDS — re-running the scan is idempotent. */
const { db } = require("../_lib/admin");
const { readBody, tokenOk } = require("../_lib/http");
const { toBerryId } = require("../_lib/berries");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ success: false, message: "Method not allowed" });
  const body = await readBody(req);
  if (!tokenOk(body)) return res.status(401).json({ success: false, message: "Invalid server token" });

  const { minecraftUuid } = body;
  if (!minecraftUuid) return res.status(400).json({ success: false, message: "Missing minecraftUuid" });

  const raw = Array.isArray(body.berries) ? body.berries : (body.berry != null ? [body.berry] : []);
  const ids = [];
  const seen = new Set();
  let ignored = 0;
  for (const r of raw) {
    const id = toBerryId(r);
    if (!id) { ignored++; continue; }
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }

  let linkSnap;
  try { linkSnap = await db.collection("mcLinks").doc(String(minecraftUuid)).get(); }
  catch (e) { console.error("berries link lookup", e); return res.status(500).json({ success: false, message: "Server error" }); }

  const link = linkSnap.exists ? linkSnap.data() : null;
  const allowUnlinked = String(process.env.SHINYDEX_SYNC_UNLINKED || "") === "true";
  if (!link || (link.linked !== true && !allowUnlinked) || !link.uid) {
    return res.status(200).json({ success: true, message: "Player not linked", added: 0, total: 0, received: ids.length, ignored });
  }
  const uid = link.uid;
  const ref = db.collection("modBerries").doc(uid);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : {};
      const map = Object.assign({}, data.berries || {});
      let added = 0;
      for (const id of ids) { if (!map[id]) { map[id] = true; added++; } }
      tx.set(ref, {
        berries: map, updatedAt: Date.now(), lastSyncAt: Date.now(),
        minecraftName: body.minecraftName || data.minecraftName || null,
      }, { merge: true });
      return { added, total: Object.keys(map).length };
    });
    db.collection("mcLinks").doc(String(minecraftUuid)).set({ lastSyncAt: Date.now() }, { merge: true }).catch(() => {});
    return res.status(200).json({ success: true, message: "OK", added: result.added, total: result.total, received: ids.length, ignored });
  } catch (e) {
    console.error("berries write error", e);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
