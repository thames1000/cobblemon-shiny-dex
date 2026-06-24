/* POST /api/minecraft/link/verify
 * The mod sends a one-time code the player generated on the website. We match it
 * to that user's account, record the Minecraft UUID → uid link, and burn the code.
 */
const { db } = require("../../_lib/admin");
const { readBody, tokenOk } = require("../../_lib/http");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ success: false, message: "Method not allowed" });
  const body = await readBody(req);
  if (!tokenOk(body)) return res.status(401).json({ success: false, message: "Invalid server token" });

  const { linkCode, minecraftUuid, minecraftName, serverId } = body;
  if (!linkCode || !minecraftUuid) {
    return res.status(400).json({ success: false, message: "Missing linkCode or minecraftUuid" });
  }
  const code = String(linkCode).trim().toUpperCase();
  const codeRef = db.collection("linkCodes").doc(code);

  try {
    const uid = await db.runTransaction(async (tx) => {
      const snap = await tx.get(codeRef);
      if (!snap.exists) throw { http: 404, msg: "Link code not found — generate a fresh one on the website." };
      const d = snap.data();
      if (d.used) throw { http: 409, msg: "That link code was already used." };
      if (d.expiresAt && Date.now() > Number(d.expiresAt)) throw { http: 410, msg: "That link code expired — generate a new one." };

      tx.update(codeRef, { used: true, usedAt: Date.now(), minecraftUuid: String(minecraftUuid), minecraftName: minecraftName || null });
      tx.set(db.collection("mcLinks").doc(String(minecraftUuid)), {
        uid: d.uid, minecraftName: minecraftName || null, serverId: serverId || null,
        linked: true, linkedAt: Date.now(), lastSyncAt: 0,
      }, { merge: true });
      tx.set(db.collection("modDex").doc(d.uid), {
        minecraftName: minecraftName || null, updatedAt: Date.now(),
      }, { merge: true });
      return d.uid;
    });
    return res.status(200).json({ success: true, message: "Linked successfully", linkedAccountId: uid });
  } catch (e) {
    if (e && e.http) return res.status(e.http).json({ success: false, message: e.msg });
    console.error("link/verify error", e);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
