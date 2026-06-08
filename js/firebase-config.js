/* Firebase project config for ShinyDex HQ cloud sync.
 *
 * Cloud sync is OPTIONAL. Until you fill this in, the app runs exactly as before
 * (guest mode, localStorage only) and the Account card shows a "not configured" note.
 *
 * To enable accounts + cross-device sync, follow SETUP-CLOUD.md:
 *   1. Create a Firebase project, add a Web app, enable Google + Email/Password auth,
 *      and create a Cloud Firestore database.
 *   2. Copy your web app's config object from the Firebase console and paste the
 *      values below (replacing every "REPLACE_ME").
 *   3. Add your domains (localhost, <user>.github.io, <project>.vercel.app) to
 *      Firebase Auth → Settings → Authorized domains, and paste the security rules.
 *
 * These keys are PUBLIC BY DESIGN (they identify the project, they don't grant access).
 * Access is controlled by Firestore security rules, so it's safe to commit them.
 */
export const firebaseConfig = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME",
};

// True while the placeholders are still in place — cloud.js uses this to stay dormant.
export const isPlaceholder = String(firebaseConfig.apiKey).includes("REPLACE_ME");
