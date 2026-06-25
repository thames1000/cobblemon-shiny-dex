# ☁️ Cloud sync setup (optional)

ShinyDex HQ works **fully offline with no account** — progress is saved in your browser's
`localStorage`. Cloud sync is an **optional** add-on that lets you sign in and keep your
progress in sync across computers (e.g. your desktop and laptop).

It runs on **Firebase** (Google's backend-as-a-service): **Firebase Auth** for sign-in
(Google *and* email/password) and **Cloud Firestore** for per-user storage. The free
**Spark** plan is far more than enough for personal use, and there's no build step — the
app loads the Firebase SDK straight from a CDN.

You only need to do this **once**, and only if you want sync. Until you do, the app's
*Account & cloud sync* card just shows a "not set up" note.

---

## 1. Create a Firebase project

1. Go to <https://console.firebase.google.com> and **Add project** (any name, e.g. `shinydex-hq`).
   Google Analytics is optional — you can skip it.
2. In the project, click the **Web** icon (`</>`) to **Add a web app**. Give it a nickname.
   You do **not** need Firebase Hosting (we deploy to GitHub Pages / Vercel ourselves).
3. Firebase shows you a **config object** that looks like this — keep this tab open, you'll
   copy these values in step 4:

   ```js
   const firebaseConfig = {
     apiKey: "AIza………",
     authDomain: "shinydex-hq.firebaseapp.com",
     projectId: "shinydex-hq",
     storageBucket: "shinydex-hq.appspot.com",
     messagingSenderId: "1234567890",
     appId: "1:1234567890:web:abc123………",
   };
   ```

## 2. Turn on the sign-in methods

In the console → **Build → Authentication → Get started → Sign-in method**, enable:

- **Email/Password** (toggle Enable, Save).
- **Google** (toggle Enable, pick a support email, Save).

## 3. Create the Firestore database

1. Console → **Build → Firestore Database → Create database**.
2. Choose a location, start in **Production mode** (we set rules in step 5).
3. After it's created, open the **Rules** tab and paste **exactly** this, then **Publish**:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       // Each signed-in user can read/write only their own document.
       match /users/{uid} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }

       // --- ShinyDex Link (Minecraft mod sync) — only needed if you set that up ---
       // One-time link codes a signed-in user generates; the backend (Admin SDK,
       // which bypasses these rules) burns them on /minecraft/link/verify.
       match /linkCodes/{code} {
         allow create: if request.auth != null
                       && request.resource.data.uid == request.auth.uid;
         allow read, delete: if request.auth != null
                       && resource.data.uid == request.auth.uid;
       }
       // Mod-sourced caught/shiny: the backend (Admin SDK) writes new catches; the
       // owner can read, and can write their OWN doc to push site-side corrections
       // (e.g. removing an evolved Pokémon so the upgrade-only pull can't re-add it).
       match /modDex/{uid} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
       // Mod-sourced berry collection, written ONLY by the backend; owner can read.
       match /modBerries/{uid} {
         allow read: if request.auth != null && request.auth.uid == uid;
       }
       // Minecraft UUID → account links: backend only, no client access.
       match /mcLinks/{uuid} {
         allow read, write: if false;
       }
     }
   }
   ```

   This is what makes your data private — every user can only touch `users/<their own uid>`
   (plus reading their own mod-sync data). The `linkCodes` / `modDex` / `mcLinks` blocks are
   only relevant if you wire up the Minecraft mod — see **[SETUP-MOD-SYNC.md](SETUP-MOD-SYNC.md)**.

## 4. Paste your config into the app

Open [`js/firebase-config.js`](js/firebase-config.js) and replace every `REPLACE_ME` with the
matching value from step 1's config object:

```js
export const firebaseConfig = {
  apiKey: "AIza………",
  authDomain: "shinydex-hq.firebaseapp.com",
  projectId: "shinydex-hq",
  storageBucket: "shinydex-hq.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abc123………",
};
```

> **Are these keys secret?** No — a Firebase web `apiKey` only *identifies* your project; it
> doesn't grant access. Access is controlled entirely by the security rules in step 3, so it's
> safe to commit this file. (Don't paste a *service-account / Admin SDK* key here — that's a
> different, secret credential you won't need.)

## 5. Authorize your domains

Firebase only allows sign-in from domains you list. Console → **Authentication → Settings →
Authorized domains → Add domain**, and add each place you run the app:

- `localhost` (already there by default — for local testing)
- `your-username.github.io` (your GitHub Pages domain)
- `your-project.vercel.app` (your Vercel domain)
- any custom domain you point at it

## 6. Done — try it

Reload the app and open the **Data** tab. The *Account & cloud sync* card now shows sign-in.

- **Sign up** with email/password, or **Sign in with Google**.
- On first sign-in, your existing local progress is uploaded to the cloud.
- Sign in on your other computer → it pulls your progress down.
- If both devices already had progress, you'll get a **conflict chooser** (Use cloud / Keep this
  device / Merge) — nothing is overwritten until you pick.

---

## Notes & troubleshooting

- **Guest mode always works.** You never *have* to sign in; the app stays usable offline, and
  the JSON Export/Import backup still works regardless.
- **Popup blocked?** Google sign-in opens a popup; if your browser/installed-PWA blocks it, the
  app automatically falls back to a full-page redirect sign-in.
- **`auth/unauthorized-domain`** when signing in → you missed step 5 for that domain.
- **Nothing syncing / permission errors** → re-check the rules in step 3 are published.
- **Where's my data?** Console → Firestore → `users` collection → a document named after your
  account's user id, with your whole progress stored as a JSON string in the `data` field.
- **Bumping the SDK version** → edit `VERSION` at the top of [`js/cloud.js`](js/cloud.js).
