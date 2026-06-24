/* Small request helpers shared by the ShinyDex Link endpoints. */

// Vercel parses application/json bodies into req.body, but be defensive about
// raw streams (some runtimes/content-types don't).
function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  if (typeof req.body === "string") {
    try { return Promise.resolve(JSON.parse(req.body || "{}")); } catch (_) { return Promise.resolve({}); }
  }
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

// The mod puts serverToken in the body. Compare against the env secret.
function tokenOk(body) {
  const expected = process.env.SHINYDEX_SERVER_TOKEN;
  return !!expected && !!body && body.serverToken === expected;
}

module.exports = { readBody, tokenOk };
