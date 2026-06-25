/* Cloud sync for ShinyDex HQ — Firebase Auth + Cloud Firestore.
 *
 * This is the ONLY file that touches Firebase. It's an ES module (loaded with
 * <script type="module">) so it can import the Firebase SDK from the CDN with no
 * build step. app.js stays a classic script; the two talk through a tiny bridge:
 *
 *   cloud  -> app : CustomEvents "cloud-auth" {user|null} and "cloud-status" {state,...}
 *   app -> cloud  : window.ShinyCloud.{signInGoogle, signUpEmail, signInEmail,
 *                                      sendReset, signOutUser, save(json), load()}
 *
 * Cloud sync is OPTIONAL. With placeholder config (the default), this module marks
 * itself unconfigured and does nothing — the app keeps working in guest mode.
 *
 * Data model: one doc per user at users/{uid} = { data:<state JSON string>,
 * updatedAt:<ms>, app:'shinydex-hq' }. The whole state is stored as a single JSON
 * string so Firestore's no-nested-array rule (config.unchainedThresholds) can't bite.
 */
import { firebaseConfig, isPlaceholder } from "./firebase-config.js";

const VERSION = "10.14.1";
const APP_URL = `https://www.gstatic.com/firebasejs/${VERSION}/firebase-app.js`;
const AUTH_URL = `https://www.gstatic.com/firebasejs/${VERSION}/firebase-auth.js`;
const FS_URL = `https://www.gstatic.com/firebasejs/${VERSION}/firebase-firestore.js`;

function emitStatus(state, extra) {
  window.dispatchEvent(new CustomEvent("cloud-status", { detail: Object.assign({ state }, extra || {}) }));
}
function emitAuth(user) {
  window.dispatchEvent(new CustomEvent("cloud-auth", { detail: { user } }));
}
// Firebase error codes are ugly ("auth/invalid-credential"); map the common ones.
function friendly(err) {
  const code = (err && err.code) || "";
  const map = {
    "auth/invalid-credential": "Wrong email or password.",
    "auth/wrong-password": "Wrong email or password.",
    "auth/user-not-found": "No account with that email.",
    "auth/invalid-email": "That doesn't look like a valid email.",
    "auth/email-already-in-use": "That email already has an account — log in instead.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/popup-closed-by-user": "Sign-in was cancelled.",
    "auth/network-request-failed": "Network error — check your connection.",
    "auth/too-many-requests": "Too many attempts — try again later.",
    "auth/unauthorized-domain": "This domain isn't authorized in Firebase Auth settings.",
  };
  return map[code] || (err && err.message) || "Something went wrong.";
}

// A short, unambiguous one-time link code (no 0/O/1/I) the player types in-game
// as `/shinydex link <code>`. 32^8 space — collisions are not a concern.
function makeLinkCode() {
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (let i = 0; i < 8; i++) s += alpha[bytes[i] % alpha.length];
  return s.slice(0, 4) + "-" + s.slice(4);
}

// Not configured: stay dormant, tell the UI, and don't load the SDK at all.
if (isPlaceholder) {
  window.ShinyCloud = { configured: false };
  emitStatus("unconfigured");
} else {
  bootCloud().catch((err) => {
    window.ShinyCloud = { configured: false };
    emitStatus("error", { message: "Cloud sync failed to load: " + friendly(err) });
  });
}

async function bootCloud() {
  const [{ initializeApp }, authMod, fsMod] = await Promise.all([
    import(APP_URL),
    import(AUTH_URL),
    import(FS_URL),
  ]);
  const {
    getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
    getRedirectResult, createUserWithEmailAndPassword, signInWithEmailAndPassword,
    signOut, sendPasswordResetEmail,
  } = authMod;
  const { initializeFirestore, doc, getDoc, setDoc } = fsMod;

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  // Auto-detect long-polling instead of the default streaming WebChannel. Firefox
  // (and some extensions / corporate proxies) break the WebChannel transport, which
  // the SDK then surfaces as a misleading "client is offline" error. Long-polling
  // uses ordinary HTTP requests and works everywhere.
  const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  const googleProvider = new GoogleAuthProvider();
  const userDoc = (uid) => doc(db, "users", uid);

  // Clear out any redirect result left over from an older build (harmless if none).
  getRedirectResult(auth).catch(() => {});

  window.ShinyCloud = {
    configured: true,
    currentUser: () => auth.currentUser,

    async signInGoogle() {
      // Popup ONLY. We deliberately don't fall back to signInWithRedirect: this is a
      // static site whose authDomain (…firebaseapp.com) differs from the app's origin
      // (github.io / vercel.app), and the redirect flow breaks in storage-partitioned
      // browsers with "missing initial state". Popup is the reliable path here.
      try {
        await signInWithPopup(auth, googleProvider);
      } catch (err) {
        const code = (err && err.code) || "";
        if (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment") {
          throw new Error("Pop-up blocked. Allow pop-ups for this site and try again — or use email/password sign-in below.");
        }
        if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
          throw new Error("Sign-in was cancelled.");
        }
        throw new Error(friendly(err));
      }
    },
    async signUpEmail(email, password) {
      try { await createUserWithEmailAndPassword(auth, email, password); }
      catch (err) { throw new Error(friendly(err)); }
    },
    async signInEmail(email, password) {
      try { await signInWithEmailAndPassword(auth, email, password); }
      catch (err) { throw new Error(friendly(err)); }
    },
    async sendReset(email) {
      try { await sendPasswordResetEmail(auth, email); }
      catch (err) { throw new Error(friendly(err)); }
    },
    async signOutUser() {
      try { await signOut(auth); }
      catch (err) { throw new Error(friendly(err)); }
    },

    // Read the signed-in user's cloud copy. Returns {json, updatedAt} or null.
    async load() {
      const u = auth.currentUser;
      if (!u) return null;
      const snap = await getDoc(userDoc(u.uid));
      if (!snap.exists()) return null;
      const d = snap.data() || {};
      if (typeof d.data !== "string") return null;
      return { json: d.data, updatedAt: Number(d.updatedAt) || 0 };
    },
    // Write the signed-in user's cloud copy.
    async save(json) {
      const u = auth.currentUser;
      if (!u) return;
      let updatedAt = 0;
      try { updatedAt = Number(JSON.parse(json).updatedAt) || 0; } catch (_) {}
      await setDoc(userDoc(u.uid), { data: json, updatedAt, app: "shinydex-hq" });
    },

    // ---- ShinyDex Link (Minecraft mod) ----
    // Create a one-time code tying this account to a server link. The backend
    // (Admin SDK) burns it when the mod calls /minecraft/link/verify.
    async createLinkCode() {
      const u = auth.currentUser;
      if (!u) throw new Error("Sign in first to link a server.");
      const code = makeLinkCode();
      const now = Date.now();
      const expiresAt = now + 15 * 60 * 1000; // 15 minutes
      await setDoc(doc(db, "linkCodes", code), {
        uid: u.uid, used: false, createdAt: now, expiresAt, app: "shinydex-hq",
        displayName: u.displayName || null, email: u.email || null,
      });
      return { code, expiresAt };
    },
    // Read the mod-sourced caught/shiny map for this user (written by the backend).
    // Returns { dex:{<num>:state}, variants:{<id>:state}, minecraftName, … } or null.
    async loadModDex() {
      const u = auth.currentUser;
      if (!u) return null;
      const snap = await getDoc(doc(db, "modDex", u.uid));
      if (!snap.exists()) return null;
      const d = snap.data() || {};
      return {
        dex: d.dex && typeof d.dex === "object" ? d.dex : {},
        variants: d.variants && typeof d.variants === "object" ? d.variants : {},
        minecraftName: d.minecraftName || null,
        lastSyncAt: Number(d.lastSyncAt) || 0,
        updatedAt: Number(d.updatedAt) || 0,
      };
    },
    // Read the mod-sourced berry collection for this user (written by the backend
    // /minecraft/berries endpoint). Returns { berries:{<id>:true}, … } or null.
    async loadModBerries() {
      const u = auth.currentUser;
      if (!u) return null;
      const snap = await getDoc(doc(db, "modBerries", u.uid));
      if (!snap.exists()) return null;
      const d = snap.data() || {};
      return {
        berries: d.berries && typeof d.berries === "object" ? d.berries : {},
        minecraftName: d.minecraftName || null,
        updatedAt: Number(d.updatedAt) || 0,
      };
    },
  };

  emitStatus("ready");
  onAuthStateChanged(auth, (user) => {
    emitAuth(user ? { uid: user.uid, email: user.email, displayName: user.displayName } : null);
  });
}
