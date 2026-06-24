/* POST /api/minecraft/test-event — connectivity check only. Validates the token
 * and echoes a success shape WITHOUT persisting, so /shinydex test never pollutes
 * a player's real dex. */
const { readBody, tokenOk, truthy } = require("../_lib/http");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ success: false, message: "Method not allowed" });
  const body = await readBody(req);
  if (!tokenOk(body)) return res.status(401).json({ success: false, message: "Invalid server token" });

  return res.status(200).json({
    success: true,
    duplicate: false,
    message: "Test event received — backend reachable and token valid.",
    updated: { normalCaught: true, shinyCaught: truthy(body.shiny), newDexEntry: false },
  });
};
