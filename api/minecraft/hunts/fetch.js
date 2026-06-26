/* POST /api/minecraft/hunts/fetch
 * Return saved progress for ONE hunt (a player + species, optionally a form). The
 * mod calls this when a hunt starts, to resume the counter. Read-only.
 *
 * By default this only looks at the player's ACTIVE hunts. When `includeInactive` is
 * set (the mod sends it when STARTING a new hunt), it falls back to the inactive
 * history to find a start point — so picking a species you hunted before resumes from
 * where you left off. The response's `status` says which bucket the hunt came from.
 * Responds `{ found:false, hunt:null }` when there's nothing to resume (including
 * unlinked players), so the mod simply starts at 0.
 */
const { db } = require("../../_lib/admin");
const { readBody, tokenOk, truthy } = require("../../_lib/http");
const { huntKey, readBuckets } = require("../../_lib/hunts");

const notFound = (res, message) => res.status(200).json({ success: true, found: false, hunt: null, message });

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ success: false, message: "Method not allowed" });
  const body = await readBody(req);
  if (!tokenOk(body)) return res.status(401).json({ success: false, message: "Invalid server token" });

  const { minecraftUuid, species } = body;
  if (!minecraftUuid) return res.status(400).json({ success: false, message: "Missing minecraftUuid" });
  if (!species) return res.status(400).json({ success: false, message: "Missing species" });

  const key = huntKey(species, body.form);
  const includeInactive = truthy(body.includeInactive);

  let linkSnap;
  try { linkSnap = await db.collection("mcLinks").doc(String(minecraftUuid)).get(); }
  catch (e) { console.error("hunts/fetch link lookup", e); return res.status(500).json({ success: false, message: "Server error" }); }

  const link = linkSnap.exists ? linkSnap.data() : null;
  const allowUnlinked = String(process.env.SHINYDEX_SYNC_UNLINKED || "") === "true";
  if (!link || (link.linked !== true && !allowUnlinked) || !link.uid) {
    return notFound(res, "Player not linked");
  }

  try {
    const snap = await db.collection("modHunts").doc(link.uid).get();
    const { active, inactive } = readBuckets(snap.exists ? snap.data() : null);
    // Resume an active hunt first; only consult history when starting a new hunt.
    let hunt = active[key];
    let status = "active";
    if (!hunt && includeInactive) { hunt = inactive[key]; status = "inactive"; }
    if (!hunt) return notFound(res, "No saved hunt");
    return res.status(200).json({ success: true, found: true, status, hunt });
  } catch (e) {
    console.error("hunts/fetch read error", e);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
