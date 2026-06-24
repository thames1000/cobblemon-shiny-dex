/* Canonical berry ids (the website's Berries tab is keyed by berry-guide.json)
 * and a tolerant mapper from whatever the mod sends to a site id. */
const GUIDE = require("../../js/data/berry-guide.json");
const VALID = new Set(GUIDE.map((b) => b.id));

// Accepts a bare site id ("occa") or a full item id ("cobblemon:occa_berry").
// Returns the canonical site id, or null if it isn't a known berry.
function toBerryId(raw) {
  let s = String(raw || "").trim().toLowerCase();
  if (!s) return null;
  const colon = s.indexOf(":");
  if (colon >= 0) s = s.slice(colon + 1);       // drop namespace
  if (s.endsWith("_berry")) s = s.slice(0, -6);  // cobblemon:occa_berry -> occa
  s = s.replace(/_/g, "-");
  return VALID.has(s) ? s : null;
}

module.exports = { VALID, toBerryId };
