/* Firebase Admin SDK init for the ShinyDex Link backend.
 *
 * The Minecraft server authenticates to us with a shared SHINYDEX_SERVER_TOKEN
 * (not a Firebase user), so these functions need Admin privileges to write to
 * Firestore on a linked user's behalf. The Admin SDK BYPASSES security rules, so
 * the rules can keep clients locked to their own data while we write everywhere.
 *
 * Credentials come from env vars (set in the Vercel dashboard — never committed):
 *   FIREBASE_SERVICE_ACCOUNT  — the service-account JSON, raw or base64-encoded.
 *   SHINYDEX_SERVER_TOKEN     — shared secret; must match the mod's serverToken.
 */
const admin = require("firebase-admin");

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT env var is not set");
  let json;
  try {
    json = JSON.parse(raw);
  } catch (_) {
    // Also accept base64-encoded JSON — easier to paste into some env-var UIs.
    try { json = JSON.parse(Buffer.from(raw, "base64").toString("utf8")); }
    catch (__) { throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON or base64 JSON"); }
  }
  // Env-var stores escape the private key's newlines; restore them.
  if (json.private_key) json.private_key = String(json.private_key).replace(/\\n/g, "\n");
  return json;
}

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(getServiceAccount()) });
}

const db = admin.firestore();
module.exports = { admin, db };
