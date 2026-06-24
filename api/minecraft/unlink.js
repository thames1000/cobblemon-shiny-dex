/* POST /api/minecraft/unlink — mark a Minecraft UUID's link inactive. */
const { db } = require("../_lib/admin");
const { readBody, tokenOk } = require("../_lib/http");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ success: false, message: "Method not allowed" });
  const body = await readBody(req);
  if (!tokenOk(body)) return res.status(401).json({ success: false, message: "Invalid server token" });

  const { minecraftUuid } = body;
  if (!minecraftUuid) return res.status(400).json({ success: false, message: "Missing minecraftUuid" });

  try {
    await db.collection("mcLinks").doc(String(minecraftUuid))
      .set({ linked: false, unlinkedAt: Date.now() }, { merge: true });
    return res.status(200).json({ success: true, message: "Unlinked" });
  } catch (e) {
    console.error("unlink error", e);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
