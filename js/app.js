/* ShinyDex HQ — Cobblemon x Create shiny living dex tracker.
 *
 * Vanilla JS PWA (no build step) so it deploys to GitHub Pages as static files
 * and works offline. Progress is manual and lives in localStorage; reference
 * data (species.json, forms.json) is bundled and read-only.
 */

const STORAGE_KEY = "shinydex-hq-v1";
const SPRITE_BASE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon";
// Pokémon Showdown serves form-specific sprites by name (covers regional + cosmetic
// variants the PokeAPI national-dex sprites don't). Pixel style matches the app.
const SHOWDOWN_BASE = "https://play.pokemonshowdown.com/sprites/gen5";
// Showdown serves shinies from a SEPARATE directory, not a /shiny/ subfolder.
const SHOWDOWN_SHINY_BASE = "https://play.pokemonshowdown.com/sprites/gen5-shiny";
// Cobblemon-original model variants (Magikarp/Gyarados Jump, Torterra trees, …)
// have no Showdown sprite — the Cobblemon Wiki hosts a render of each (normal +
// shiny). MediaWiki's Special:FilePath redirects a filename to the real image,
// so we don't need the MD5-hashed /images/ path.
const WIKI_FILEPATH = (file) =>
  "https://wiki.cobblemon.com/index.php/Special:FilePath/" + encodeURIComponent(file.replace(/ /g, "_"));

// Dex state cycle. Right-click steps back.
const DEX_STATES = ["none", "seen", "caught", "shiny", "boxed"];
const STATE_BADGE = { seen: "S", caught: "C", shiny: "✨", boxed: "📦" };

let SPECIES = [];   // [{dex,name,types,gen}]
let MOVES = [];     // [{name,type,category,power}] — Party builder
let MOVE_BY_NAME = {}; // name -> move meta
let COACH = {};     // dex -> {base,bst,abilities,moves[]}
let FORMS = null;   // {mega:[],primal:[],gmax:[]}
let VARIANTS = null; // {regional:{alolan,galarian,hisuian,paldean}, cosmetic:[]}
let LEGENDS = null;  // {tiers:[], list:[{dex,tier,shiny,sys,struct,note}]}
let LEGEND_BY_DEX = {}; // dex -> legendary entry
let DEX_BY_NUM = {}; // dex -> species

// Pack defaults (Cobblemon + Unchained + Cobbreeding). All editable in-app.
function defaultConfig() {
  return {
    baseShinyRate: 8192,
    unchainedThresholds: [[100, 1], [300, 2], [500, 3]], // [koStreak, +shinyChances]
    masudaMultiplier: 4,
    huntHotkey: "Space", // KeyboardEvent.code that does +1 mid-hunt; "" = disabled
    randomScope: "smart", // pool for 🎲 Surprise me — see randomPool()
  };
}
function defaultHunt() {
  return { mode: "chain", activeDex: null, activeVariant: null, sessions: {}, finds: [] };
}
// ---- Party builder state ----
const STATS = [["hp", "HP"], ["atk", "Atk"], ["def", "Def"], ["spa", "SpA"], ["spd", "SpD"], ["spe", "Spe"]];
function emptyMember() {
  return {
    dex: null, nature: "", ability: "", item: "", moves: ["", "", "", ""],
    evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  };
}
function uid() { return "p" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
function newParty(name) {
  return { id: uid(), name: name || "Party 1", members: Array.from({ length: 6 }, emptyMember) };
}
function defaultParty() { const p = newParty("Party 1"); return { active: p.id, list: [p] }; }
function freshState() {
  return { dex: {}, forms: {}, variants: {}, legendaries: {}, berries: {}, wishlist: [], variantWishlist: [], goals: [], party: defaultParty(), config: defaultConfig(), hunt: defaultHunt() };
}
let state = freshState();

/* ---------- persistence ---------- */
function normalize() {
  if (!state.dex) state.dex = {};
  if (!state.forms) state.forms = {};
  if (!state.variants) state.variants = {};
  if (!state.legendaries) state.legendaries = {};
  if (!state.berries) state.berries = {};
  // Wishlist: unique, finite dex numbers, in add order.
  const rawWish = Array.isArray(state.wishlist) ? state.wishlist : [];
  const seenWish = new Set();
  state.wishlist = rawWish.map(Number).filter((d) => Number.isFinite(d) && !seenWish.has(d) && seenWish.add(d));
  // Variant wishlist: unique non-empty string ids (validated against VARIANT_BY_ID later).
  const rawVW = Array.isArray(state.variantWishlist) ? state.variantWishlist : [];
  const seenVW = new Set();
  state.variantWishlist = rawVW.filter((id) => typeof id === "string" && id && !seenVW.has(id) && seenVW.add(id));
  // Progress goals: keep only well-formed entries with a known type; drop dup signatures.
  const rawGoals = Array.isArray(state.goals) ? state.goals : [];
  const seenGoals = new Set();
  state.goals = rawGoals.filter((g) => {
    if (!g || typeof g !== "object" || !GOAL_TYPES[g.type]) return false;
    const sig = goalSig(g);
    if (seenGoals.has(sig)) return false;
    seenGoals.add(sig);
    if (!g.id) g.id = "g" + (g.createdAt || 0).toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    if (!Number.isFinite(g.createdAt)) g.createdAt = Date.now();
    return true;
  });
  normalizeParty();
  state.config = Object.assign(defaultConfig(), state.config || {});
  if (typeof state.config.huntHotkey !== "string") state.config.huntHotkey = "Space";
  if (!["smart", "unshiny", "all"].includes(state.config.randomScope)) state.config.randomScope = "smart";
  state.hunt = Object.assign(defaultHunt(), state.hunt || {});
  // Sessions must be a plain object of well-formed entries. Older/corrupt
  // exports may have it missing, as an array, or holding null/garbage values —
  // rebuild a clean map so the Active-hunts UI can never trip over a bad entry.
  const rawSessions = state.hunt.sessions;
  const cleanSessions = {};
  if (rawSessions && typeof rawSessions === "object") {
    for (const [k, s] of Object.entries(rawSessions)) {
      if (!s || typeof s !== "object") continue;
      const dex = Number(s.dex);
      const mode = typeof s.mode === "string" ? s.mode : (String(k).split(":")[0] || "chain");
      if (!Number.isFinite(dex)) continue;
      const variant = typeof s.variant === "string" && s.variant ? s.variant : null;
      cleanSessions[huntKey(mode, dex, variant)] = {
        mode, dex, variant,
        count: Number.isFinite(s.count) ? Math.max(0, Math.floor(s.count)) : 0,
        startedAt: Number.isFinite(s.startedAt) ? s.startedAt : Date.now(),
      };
    }
  }
  state.hunt.sessions = cleanSessions;
  if (!Array.isArray(state.hunt.finds)) state.hunt.finds = [];
  // Backfill fields added after a find was first logged, so old saves/imports show
  // up cleanly in the showcase: a stable id and an obtainment origin.
  state.hunt.finds.forEach((f, i) => {
    if (f && typeof f === "object") {
      if (!f.id) f.id = "f" + (f.foundAt || 0).toString(36) + i.toString(36);
      if (!f.origin) f.origin = f.mode === "breeding" ? "hatched" : "self";
    }
  });
  if (state.hunt.activeDex != null && !Number.isFinite(Number(state.hunt.activeDex))) state.hunt.activeDex = null;
  if (typeof state.hunt.activeVariant !== "string" || !state.hunt.activeVariant) state.hunt.activeVariant = null;
}
function normalizeParty() {
  const p = state.party;
  if (!p || !Array.isArray(p.list) || !p.list.length) { state.party = defaultParty(); return; }
  for (const party of p.list) {
    if (!party.id) party.id = uid();
    if (!party.name) party.name = "Party";
    if (!Array.isArray(party.members)) party.members = [];
    while (party.members.length < 6) party.members.push(emptyMember());
    party.members = party.members.slice(0, 6).map((m) => {
      const e = emptyMember();
      if (!m || typeof m !== "object") return e;
      return {
        dex: Number.isFinite(m.dex) ? m.dex : null,
        nature: typeof m.nature === "string" ? m.nature : "",
        ability: typeof m.ability === "string" ? m.ability : "",
        item: typeof m.item === "string" ? m.item : "",
        moves: [0, 1, 2, 3].map((i) => (Array.isArray(m.moves) && m.moves[i]) || ""),
        evs: Object.assign(e.evs, m.evs || {}),
        ivs: Object.assign(e.ivs, m.ivs || {}),
      };
    });
  }
  if (!p.active || !p.list.some((x) => x.id === p.active)) p.active = p.list[0].id;
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (d && typeof d === "object") state = Object.assign(freshState(), d);
  } catch (_) { /* keep defaults */ }
  normalize();
}
function save() {
  state.updatedAt = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (cloudActive && !applyingRemote) scheduleCloudPush();
}

/* ---------- cloud sync (optional) ----------
 * All Firebase code lives in the cloud.js ES module; we talk to it only through
 * window.ShinyCloud and the "cloud-auth"/"cloud-status" events (wired in boot()).
 * Guest mode is the default — none of this runs until the user signs in, and a
 * sign-in NEVER silently overwrites local progress (conflicts prompt the user). */
let cloudActive = false;    // true once signed in and the initial sync has resolved
let applyingRemote = false; // guard so applying a cloud copy doesn't echo back up
let cloudPushTimer = null;
let cloudUser = null;       // {uid,email,displayName} | null
let lastSyncAt = 0;
let pendingRemote = null;   // remote copy awaiting a conflict choice

// Exposed synchronously so it exists before the deferred cloud.js module runs.
window.ShinyApp = {
  getStateJson: () => JSON.stringify(state),
  applyRemote: (json) => applyRemoteState(json),
  hasProgress: () => localHasProgress(),
  updatedAt: () => state.updatedAt || 0,
};

// Does local state hold real progress (vs fresh defaults)? Drives "seed cloud" vs
// "conflict" on first sign-in so we never clobber a populated cloud or device.
function localHasProgress() {
  const h = state.hunt || {};
  return (
    Object.keys(state.dex || {}).length > 0 ||
    Object.keys(state.forms || {}).length > 0 ||
    Object.keys(state.variants || {}).length > 0 ||
    Object.keys(state.berries || {}).length > 0 ||
    Object.keys(h.sessions || {}).length > 0
  );
}

function emitCloudStatus(stateName, extra) {
  window.dispatchEvent(new CustomEvent("cloud-status", { detail: Object.assign({ state: stateName }, extra || {}) }));
}
function scheduleCloudPush() {
  if (!cloudActive || !window.ShinyCloud || !window.ShinyCloud.configured) return;
  if (cloudPushTimer) clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(pushToCloud, 1500);
  emitCloudStatus("syncing");
}
async function pushToCloud() {
  cloudPushTimer = null;
  if (!cloudActive || !window.ShinyCloud) return;
  try {
    await window.ShinyCloud.save(JSON.stringify(state));
    emitCloudStatus("synced", { at: Date.now() });
  } catch (e) {
    emitCloudStatus("error", { message: (e && e.message) || "Sync failed" });
  }
}

// Replace local state with a cloud copy WITHOUT pushing it straight back up.
function applyRemoteState(json) {
  let d;
  try { d = JSON.parse(json); } catch (_) { return; }
  if (!d || typeof d !== "object") return;
  applyingRemote = true;
  state = Object.assign(freshState(), d);
  normalize();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  renderAll();
  applyingRemote = false;
}
function renderAll() {
  renderDex(); renderForms(); renderVariants(); renderLegendary(); renderBerries(); renderParty();
  fillConfigInputs(); renderHunt(); renderBoxes(); renderSnack();
  renderDashboard(); renderStats(); renderLog();
}

/* ----- account UI ----- */
const SYNC_TEXT = {
  syncing: "Syncing…",
  synced: "All changes synced ✓",
  error: "Sync error — changes saved on this device",
  offline: "Offline — will sync when reconnected",
};
function showAccountView() {
  const configured = !!(window.ShinyCloud && window.ShinyCloud.configured);
  if (els.accountUnconfigured) els.accountUnconfigured.hidden = configured;
  if (els.accountSignedout) els.accountSignedout.hidden = !configured || !!cloudUser;
  if (els.accountSignedin) els.accountSignedin.hidden = !configured || !cloudUser;
  if (cloudUser && els.accountWho) els.accountWho.textContent = cloudUser.email || cloudUser.displayName || "Signed in";
}
function setSyncBadge(stateName, message) {
  const el = els.accountStatus;
  if (!el) return;
  const known = SYNC_TEXT[stateName];
  el.dataset.sync = known ? stateName : "";
  el.textContent = stateName === "error" && message ? message : (known || "");
}
function showAuthError(msg) {
  if (!els.authError) return;
  els.authError.textContent = msg || "";
  els.authError.hidden = !msg;
}
function fmtWhen(ms) {
  if (!ms) return "unknown time";
  try { return new Date(ms).toLocaleString(); } catch (_) { return "unknown time"; }
}
function relTime(ms) {
  if (!ms) return "never";
  const d = Date.now() - ms;
  if (d < 0) return "just now";
  if (d < 60000) return "just now";
  const mins = Math.floor(d / 60000); if (mins < 60) return mins + (mins === 1 ? " min ago" : " mins ago");
  const hrs = Math.floor(d / 3600000); if (hrs < 24) return hrs + (hrs === 1 ? " hour ago" : " hours ago");
  const days = Math.floor(d / 86400000); if (days < 30) return days + (days === 1 ? " day ago" : " days ago");
  return fmtWhen(ms);
}

/* ---------- backup & sync confidence ----------
 * Device-local timestamps (NOT part of the synced state) so the UI can reassure
 * the user their progress is safe and nudge a local export when it goes stale. */
const META = { backup: "shinydex-last-backup", sync: "shinydex-last-sync", snooze: "shinydex-backup-snooze" };
const DAY_MS = 86400000;
const BACKUP_STALE_DAYS = 7;
function metaGet(k) { try { return Number(localStorage.getItem(k)) || 0; } catch (_) { return 0; } }
function metaSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (_) { /* private mode */ } }
// Progress exists locally and has changed since the last export.
function hasUnbackedChanges() { return localHasProgress() && (state.updatedAt || 0) > metaGet(META.backup); }
// Stale = real unsaved-to-file progress, and it's been a while since the last export.
function backupIsStale() {
  return hasUnbackedChanges() && (Date.now() - metaGet(META.backup)) > BACKUP_STALE_DAYS * DAY_MS;
}
// Whether to show the dashboard nudge: stale, not snoozed, and not already covered
// by an active, freshly-synced cloud backup.
function shouldNagBackup() {
  if (cloudActive && (lastSyncAt || metaGet(META.sync))) return false;
  return backupIsStale() && Date.now() > metaGet(META.snooze);
}
function snoozeBackup() { metaSet(META.snooze, Date.now() + 3 * DAY_MS); renderDashBackup(); }

// A one-line collection summary used by the merge preview and the health card.
function collectionSummary(s) {
  const dex = (s && s.dex) || {};
  let caught = 0, shiny = 0, boxed = 0;
  for (const k in dex) {
    const v = dex[k];
    if (v === "caught" || v === "shiny" || v === "boxed") caught++;
    if (v === "shiny" || v === "boxed") shiny++;
    if (v === "boxed") boxed++;
  }
  return {
    caught, shiny, boxed,
    variants: Object.values((s && s.variants) || {}).filter(Boolean).length,
    legend: Object.values((s && s.legendaries) || {}).filter(Boolean).length,
    finds: (((s && s.hunt) || {}).finds || []).length,
  };
}

// Health panel in the Data tab: last save / last backup / last sync + a verdict.
function renderBackupCard() {
  const el = document.getElementById("backup-health");
  if (!el) return;
  const sm = collectionSummary(state);
  const lastBackup = metaGet(META.backup);
  const lastSync = lastSyncAt || metaGet(META.sync);
  const cloudOn = !!(window.ShinyCloud && window.ShinyCloud.configured && cloudUser);
  let status, cls;
  if (cloudOn && cloudActive && lastSync) { status = "✓ Synced to the cloud — your progress is backed up."; cls = "ok"; }
  else if (!localHasProgress()) { status = "No progress yet — nothing to back up."; cls = "neutral"; }
  else if (!lastBackup) { status = "⚠ You've never exported a backup. Your progress lives only in this browser."; cls = "warn"; }
  else if (backupIsStale()) { status = `⚠ Last backup was ${relTime(lastBackup)} and you've caught more since. Export again to be safe.`; cls = "warn"; }
  else if (hasUnbackedChanges()) { status = "You've made changes since your last export — a fresh backup wouldn't hurt."; cls = "neutral"; }
  else { status = "✓ Your latest progress is backed up."; cls = "ok"; }
  el.innerHTML =
    `<div class="bk-status bk-${cls}">${status}</div>` +
    `<div class="bk-rows">` +
      `<div class="bk-row"><span>Last saved on this device</span><b>${relTime(state.updatedAt || 0)}</b></div>` +
      `<div class="bk-row"><span>Last backup downloaded</span><b>${lastBackup ? relTime(lastBackup) : "never"}</b></div>` +
      (cloudOn ? `<div class="bk-row"><span>Last cloud sync</span><b>${lastSync ? relTime(lastSync) : "—"}</b></div>` : "") +
    `</div>` +
    `<div class="bk-summary muted">Tracking ✨ ${sm.shiny} shiny · 📦 ${sm.boxed} boxed · ${sm.variants} variants · ${sm.legend} legendaries · ${sm.finds} logs</div>`;
}

// Dashboard nudge — only appears when a local-only backup has gone stale.
function renderDashBackup() {
  const el = document.getElementById("dash-backup");
  if (!el) return;
  if (!shouldNagBackup()) { el.hidden = true; el.innerHTML = ""; return; }
  const last = metaGet(META.backup);
  el.hidden = false;
  el.innerHTML =
    `<h2>💾 Back up your progress</h2>` +
    `<p class="hint">Your shinies live only in this browser${last ? ` — your last export was ${relTime(last)}` : " and you haven't exported a backup yet"}. ` +
      `A cache-clear or browser reset could wipe everything. Download a backup to be safe.</p>` +
    `<div class="controls">` +
      `<button class="ctrl-btn good" id="dash-backup-export">⬇ Export backup</button>` +
      `<button class="ctrl-btn" id="dash-backup-snooze">Remind me later</button>` +
    `</div>`;
}

// Merge preview in the sign-in conflict dialog: what each copy holds and what a
// merge would produce, so "Merge both" is a confident click.
function renderConflictPreview(remoteJson) {
  const el = document.getElementById("conflict-preview");
  if (!el) return;
  let cloud = null;
  try { cloud = JSON.parse(remoteJson); } catch (_) { /* leave null */ }
  const merged = mergeRemote(remoteJson);
  const L = collectionSummary(state), C = collectionSummary(cloud || {}), M = collectionSummary(merged || state);
  const row = (lbl, s, hl) => `<tr${hl ? ' class="bk-pre-merge"' : ""}><td>${lbl}</td><td>${s.shiny}</td><td>${s.boxed}</td><td>${s.caught}</td><td>${s.variants}</td><td>${s.legend}</td><td>${s.finds}</td></tr>`;
  el.innerHTML =
    `<table class="bk-pre"><thead><tr><th></th><th title="Shiny">✨</th><th title="Boxed">📦</th><th>Caught</th><th>Var</th><th>Leg</th><th>Logs</th></tr></thead>` +
    `<tbody>${row("This device", L)}${row("Cloud", C)}${row("After merge", M, true)}</tbody></table>` +
    `<p class="hint" style="margin:6px 0 0">Merge keeps the further-along of each — it only ever <b>adds</b> progress, never removes it.</p>`;
}

// Reacts to a Firebase auth change relayed by cloud.js.
async function onCloudAuth(user) {
  cloudUser = user;
  showAuthError("");
  if (els.accountConflict) els.accountConflict.hidden = true;
  if (!user) { cloudActive = false; setSyncBadge(""); showAccountView(); return; }
  showAccountView();
  setSyncBadge("syncing");
  try {
    const remote = await window.ShinyCloud.load();
    cloudActive = true;
    if (!remote) {
      // First time on this account — seed the cloud from whatever is local.
      if (localHasProgress()) await pushToCloud(); else setSyncBadge("synced");
    } else if (!localHasProgress()) {
      // Nothing to lose on this device — just take the cloud copy.
      applyRemoteState(remote.json);
      setSyncBadge("synced");
    } else {
      // Both sides have data — never auto-clobber; let the user choose.
      resolveConflict(remote);
    }
    // Fold in any catches the Minecraft mod has synced since last time. Skipped
    // while a conflict chooser is open — we merge after the user resolves it.
    if (!pendingRemote) await pullModDex({ silent: true });
  } catch (e) {
    cloudActive = true; // stay signed in; saves will retry
    setSyncBadge("error", (e && e.message) || "Could not load cloud data");
  }
}

function resolveConflict(remote) {
  pendingRemote = remote;
  const localAt = state.updatedAt || 0;
  const cloudAt = remote.updatedAt || 0;
  if (els.conflictLocal) els.conflictLocal.textContent = "This device — updated " + fmtWhen(localAt);
  if (els.conflictCloud) els.conflictCloud.textContent = "Cloud — updated " + fmtWhen(cloudAt);
  renderConflictPreview(remote.json);
  if (els.accountConflict) els.accountConflict.hidden = false;
  setSyncBadge(""); // paused until the user decides
}
function finishConflict(choice) {
  const remote = pendingRemote;
  pendingRemote = null;
  if (els.accountConflict) els.accountConflict.hidden = true;
  if (!remote) return;
  if (choice === "cloud") {
    applyRemoteState(remote.json);
    setSyncBadge("synced");
  } else if (choice === "merge") {
    const merged = mergeRemote(remote.json);
    if (merged) { state = merged; normalize(); renderAll(); save(); }
  } else { // keep this device
    save();
  }
  // Now that the conflict is settled, fold in any mod-synced catches.
  pullModDex({ silent: true });
}

// Non-destructive merge: per key, keep whichever side is "further along" (higher
// number, more-advanced dex state, or any set value). Can only ADD progress, never
// remove it. Collection maps merge; party/settings keep this device's copy.
function scoreVal(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") { const i = DEX_STATES.indexOf(v); return i >= 0 ? i : (v ? 0.5 : 0); }
  return v ? 0.5 : 0;
}
function mergeMap(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    out[k] = scoreVal((b || {})[k]) > scoreVal((a || {})[k]) ? b[k] : a[k];
  }
  return out;
}
function mergeRemote(remoteJson) {
  let r;
  try { r = JSON.parse(remoteJson); } catch (_) { return null; }
  if (!r || typeof r !== "object") return null;
  const merged = Object.assign(freshState(), JSON.parse(JSON.stringify(state)));
  merged.dex = mergeMap(state.dex, r.dex);
  merged.forms = mergeMap(state.forms, r.forms);
  merged.variants = mergeMap(state.variants, r.variants);
  merged.legendaries = mergeMap(state.legendaries, r.legendaries);
  merged.berries = mergeMap(state.berries, r.berries);
  // Hunt sessions: keep the higher encounter count per hunt.
  const ls = (state.hunt && state.hunt.sessions) || {};
  const rs = (r.hunt && r.hunt.sessions) || {};
  const sessions = {};
  for (const k of new Set([...Object.keys(ls), ...Object.keys(rs)])) {
    const a = ls[k], b = rs[k];
    sessions[k] = (b && (!a || (b.count || 0) > (a.count || 0))) ? b : a;
  }
  merged.hunt = Object.assign(defaultHunt(), state.hunt || {});
  merged.hunt.sessions = sessions;
  return merged;
}

async function pullFromCloud() {
  if (!window.ShinyCloud || !cloudUser) return;
  setSyncBadge("syncing");
  try {
    const remote = await window.ShinyCloud.load();
    if (!remote) { setSyncBadge("synced"); return; }
    if (confirm("Replace this device's progress with the cloud copy?")) {
      applyRemoteState(remote.json);
    }
    setSyncBadge("synced");
  } catch (e) {
    setSyncBadge("error", (e && e.message) || "Pull failed");
  }
}

// Merge the mod-sourced caught/shiny map (written by the ShinyDex Link backend)
// into local state. Upgrade-only, exactly like the file import: it raises
// none→seen→caught→✨shiny and never downgrades or disturbs a 📦 boxed mon. Safe
// to call repeatedly. Runs automatically after sign-in; also wired to "Sync now".
async function pullModDex(opts) {
  opts = opts || {};
  if (!window.ShinyCloud || !window.ShinyCloud.configured || !window.ShinyCloud.loadModDex || !cloudUser) {
    if (!opts.silent) setModLinkStatus("Sign in (Account card above) to sync from your server.", false);
    return 0;
  }
  let md = null, mb = null;
  try {
    md = await window.ShinyCloud.loadModDex();
    if (window.ShinyCloud.loadModBerries) mb = await window.ShinyCloud.loadModBerries();
  } catch (e) {
    if (!opts.silent) setModLinkStatus("Couldn't reach the server sync: " + ((e && e.message) || "error"), false);
    return 0;
  }
  const dexMap = (md && md.dex) || {};
  const variantMap = (md && md.variants) || {};
  const berryMap = (mb && mb.berries) || {};
  if (!Object.keys(dexMap).length && !Object.keys(variantMap).length && !Object.keys(berryMap).length) {
    if (!opts.silent) setModLinkStatus("No server data yet — link a Minecraft account below, then catch something or run /shinydex berries.", true);
    return 0;
  }
  let upgraded = 0, variantsUp = 0, berriesAdded = 0;
  for (const [k, next] of Object.entries(dexMap)) {
    const dex = Number(k);
    if (!Number.isFinite(dex) || !DEX_BY_NUM[dex]) continue;
    if (MOD_STATE_RANK[next] == null) continue;
    const cur = dexState(dex);
    if (MOD_STATE_RANK[next] > MOD_STATE_RANK[cur]) {
      const wasShiny = cur === "shiny" || cur === "boxed";
      setDexState(dex, next); upgraded++;
      if (!wasShiny && (next === "shiny" || next === "boxed")) logFindFromMod(dex);
    }
  }
  // Variants: backend stores "caught"/"shiny"; state.variants uses true/"shiny".
  // Upgrade-only; variants have only caught & shiny (no seen/boxed).
  for (const [id, next] of Object.entries(variantMap)) {
    if (!VARIANT_BY_ID[id] || MOD_STATE_RANK[next] == null) continue;
    const cur = state.variants[id];
    const curRank = cur === "shiny" ? 3 : (cur ? 2 : 0);
    if (MOD_STATE_RANK[next] > curRank) { state.variants[id] = next === "shiny" ? "shiny" : true; variantsUp++; }
  }
  // Berries are a set-only collection ("have it"); only ever add, never remove.
  for (const id of Object.keys(berryMap)) {
    if (!berryMap[id] || !GUIDE_BY_ID[id]) continue;
    if (!state.berries[id]) { state.berries[id] = true; berriesAdded++; }
  }
  if (upgraded || variantsUp || berriesAdded) {
    save(); // persists locally and (since cloudActive) pushes the merged blob up
    renderDex(); renderForms(); renderVariants(); renderLegendary(); renderBerries();
    renderBoxes(); renderDashboard(); renderStats(); renderLog(); renderBackupCard();
  }
  if (!opts.silent || upgraded || variantsUp || berriesAdded) {
    const who = (md && md.minecraftName) || (mb && mb.minecraftName);
    setModLinkStatus(`Server sync — ${upgraded} dex, ${variantsUp} variants, ${berriesAdded} berries updated${who ? ` (linked to ${who})` : ""}.`, true);
  }
  return upgraded + variantsUp + berriesAdded;
}

// Create + display a one-time link code the player types in-game.
async function generateLinkCode() {
  if (!window.ShinyCloud || !window.ShinyCloud.configured) {
    setModLinkStatus("Cloud sync isn't configured for this site yet.", false); return;
  }
  if (!cloudUser) { setModLinkStatus("Sign in (Account card above) first — the code links your server catches to your account.", false); return; }
  setModLinkStatus("Generating…", true);
  try {
    const { code } = await window.ShinyCloud.createLinkCode();
    if (els.modLinkCode) {
      els.modLinkCode.hidden = false;
      els.modLinkCode.innerHTML =
        `In Minecraft, run:<br><code class="link-code">/shinydex link ${code}</code>` +
        `<span class="hint" style="display:block;margin-top:6px">Expires in 15 minutes · one use. After linking, catches sync automatically.</span>`;
    }
    if (els.modLinkStatus) els.modLinkStatus.hidden = true;
  } catch (e) { setModLinkStatus("Couldn't create a link code: " + ((e && e.message) || "error"), false); }
}

function setModLinkStatus(msg, ok) {
  const el = els.modLinkStatus;
  if (!el) return;
  el.hidden = false;
  el.textContent = msg;
  el.dataset.tone = ok ? "good" : "bad";
}

// Run a ShinyCloud auth call, surfacing any error in the account card.
async function cloudCall(fn, okMsg) {
  showAuthError("");
  try { await fn(); if (okMsg) showAuthError(okMsg); }
  catch (e) { showAuthError((e && e.message) || "Something went wrong."); }
}
function emailAuth(isSignup) {
  const email = (els.accEmail.value || "").trim();
  const pw = els.accPassword.value || "";
  if (!email || !pw) { showAuthError("Enter an email and password."); return; }
  cloudCall(() => isSignup
    ? window.ShinyCloud.signUpEmail(email, pw)
    : window.ShinyCloud.signInEmail(email, pw));
}

/* ---------- sprite helpers ---------- */
function spriteUrl(dex, shiny) {
  return `${SPRITE_BASE}/${shiny ? "shiny/" : ""}${dex}.png`;
}

/* ---------- dex tab ---------- */
function dexState(dex) { return state.dex[String(dex)] || "none"; }

function cycleDex(dex, backwards) {
  const cur = dexState(dex);
  let i = DEX_STATES.indexOf(cur);
  i = (i + (backwards ? -1 : 1) + DEX_STATES.length) % DEX_STATES.length;
  const next = DEX_STATES[i];
  if (next === "none") delete state.dex[String(dex)];
  else state.dex[String(dex)] = next;
  save();
}

// Set a dex state directly (used by the per-Pokémon detail page) and sync every
// surface that shows it: the Dex grid card, the current Box page, dashboard, stats.
function setDexState(dex, st) {
  if (st === "none") delete state.dex[String(dex)]; else state.dex[String(dex)] = st;
  save();
  syncDexCard(dex);
  if (els.boxGrid && els.boxGrid.children.length) renderBoxes();
  refreshDashboard(); refreshStats();
}

function monCard(sp) {
  const st = dexState(sp.dex);
  const shiny = st === "shiny" || st === "boxed";
  const el = document.createElement("div");
  el.className = `mon s-${st}`;
  el.dataset.dex = sp.dex;
  const nm = sp.name.replace(/-/g, " ");
  const wished = state.wishlist.includes(sp.dex);
  el.innerHTML =
    `${STATE_BADGE[st] ? `<span class="badge">${STATE_BADGE[st]}</span>` : ""}` +
    `<button class="mon-hunt" title="Start a hunt for ${nm}" aria-label="Start a hunt for ${nm}">🎯</button>` +
    `<button class="mon-star${wished ? " on" : ""}" title="${wished ? "Remove from" : "Add to"} wishlist" aria-label="${wished ? "Remove from" : "Add to"} wishlist for ${nm}">${wished ? "★" : "☆"}</button>` +
    `<button class="mon-info" title="Details for ${nm}" aria-label="Details for ${nm}">ⓘ</button>` +
    `<img loading="lazy" src="${spriteUrl(sp.dex, shiny)}" alt="${sp.name}" />` +
    `<div class="dexno">#${String(sp.dex).padStart(4, "0")}</div>` +
    `<div class="nm">${sp.name.replace(/-/g, " ")}</div>`;
  return el;
}

function matchesDexFilter(sp) {
  const gen = els.dexGen.value;
  if (gen && String(sp.gen) !== gen) return false;
  const q = els.dexSearch.value.trim().toLowerCase().replace(/^#/, "");
  if (q) {
    const byNum = String(sp.dex) === q || String(sp.dex).padStart(4, "0") === q.padStart(4, "0");
    if (!sp.name.includes(q) && !byNum) return false;
  }
  const f = els.dexFilter.value;
  const st = dexState(sp.dex);
  if (f === "need-shiny" && (st === "shiny" || st === "boxed")) return false;
  if (f === "caught-not-shiny" && st !== "caught") return false;
  if (f === "caught-any" && st !== "caught" && st !== "shiny" && st !== "boxed") return false;
  if (f === "shiny-not-boxed" && st !== "shiny") return false;
  if (f === "boxed" && st !== "boxed") return false;
  if (f === "missing" && st !== "none") return false;
  if (f === "wishlist" && !state.wishlist.includes(sp.dex)) return false;
  return true;
}

function renderDex() {
  const grid = els.dexGrid;
  grid.innerHTML = "";
  const frag = document.createDocumentFragment();
  SPECIES.filter(matchesDexFilter).forEach((sp) => frag.appendChild(monCard(sp)));
  grid.appendChild(frag);
  renderDexStats();
}

function renderDexStats() {
  const total = SPECIES.length;
  let caught = 0, shiny = 0, boxed = 0;
  for (const sp of SPECIES) {
    const st = dexState(sp.dex);
    if (st === "caught" || st === "shiny" || st === "boxed") caught++;
    if (st === "shiny" || st === "boxed") shiny++;
    if (st === "boxed") boxed++;
  }
  const pct = ((shiny / total) * 100).toFixed(1);
  els.dexStats.innerHTML =
    `<span class="stat"><b>${shiny}</b>/${total} shiny (${pct}%)</span>` +
    `<div class="bar"><i style="width:${pct}%"></i></div>` +
    `<span class="stat">📦 boxed <b>${boxed}</b></span>` +
    `<span class="stat">caught <b>${caught}</b></span>`;
}

/* ---------- boxes tab (living dex PC layout) ---------- */
const BOX_SIZE = 30;
let curBox = 0; // 0-indexed
function boxCount() { return Math.ceil(SPECIES.length / BOX_SIZE); }
function boxRange(b) { return [b * BOX_SIZE + 1, Math.min((b + 1) * BOX_SIZE, SPECIES.length)]; }

function slotCard(sp) {
  const st = dexState(sp.dex);
  const shiny = st === "shiny" || st === "boxed";
  const el = document.createElement("div");
  el.className = `slot s-${st}`;
  el.dataset.dex = sp.dex;
  el.title = `${sp.name} #${sp.dex} · ${st}`;
  // Always show the sprite + dex number so the box doubles as a placement planner.
  // Un-boxed slots use the normal sprite (dimmed); boxed/shiny use the shiny sprite.
  el.innerHTML =
    `<button class="slot-info" title="Details for ${sp.name.replace(/-/g, " ")}" aria-label="Details">ⓘ</button>` +
    `<img loading="lazy" src="${spriteUrl(sp.dex, shiny)}" alt="${sp.name}" />` +
    `<span class="slot-no">${String(sp.dex).padStart(4, "0")}</span>`;
  return el;
}

function renderBoxes() {
  if (!SPECIES.length) return;
  const total = boxCount();
  if (curBox >= total) curBox = total - 1;
  if (curBox < 0) curBox = 0;
  // (Re)build the box selector to match current data.
  if (els.boxSelect.options.length !== total) {
    els.boxSelect.innerHTML = Array.from({ length: total }, (_, b) => {
      const [lo, hi] = boxRange(b);
      return `<option value="${b}">Box ${b + 1} · #${String(lo).padStart(4, "0")}–#${String(hi).padStart(4, "0")}</option>`;
    }).join("");
  }
  els.boxSelect.value = String(curBox);

  const [lo, hi] = boxRange(curBox);
  const grid = els.boxGrid;
  grid.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (let dex = lo; dex <= hi; dex++) {
    const sp = DEX_BY_NUM[dex];
    if (sp) frag.appendChild(slotCard(sp));
  }
  grid.appendChild(frag);

  // Stats: this box + overall boxed.
  let boxedHere = 0;
  for (let dex = lo; dex <= hi; dex++) if (dexState(dex) === "boxed") boxedHere++;
  const inBox = hi - lo + 1;
  let boxedAll = 0, shinyAll = 0;
  for (const sp of SPECIES) {
    const s = dexState(sp.dex);
    if (s === "boxed") boxedAll++;
    if (s === "shiny" || s === "boxed") shinyAll++;
  }
  const pct = ((boxedAll / SPECIES.length) * 100).toFixed(1);
  els.boxesStats.innerHTML =
    `<span class="stat">This box <b>${boxedHere}</b>/${inBox} boxed</span>` +
    `<div class="bar"><i style="width:${pct}%"></i></div>` +
    `<span class="stat">Living dex <b>${boxedAll}</b>/${SPECIES.length} (${pct}%)</span>` +
    `<span class="stat">${shinyAll - boxedAll} shiny to deposit</span>`;
}

// Resolve a typed query (name or #dex) to a species; null if no match.
function findSpecies(raw) {
  const q = String(raw || "").trim().toLowerCase().replace(/^#/, "");
  if (!q) return null;
  return SPECIES.find((s) => s.name === q)
    || (/^\d+$/.test(q) ? DEX_BY_NUM[Number(q)] : null)
    || SPECIES.find((s) => s.name.startsWith(q))
    || null;
}

function gotoBox(b) { curBox = b; renderBoxes(); }

function jumpToSpecies(sp) {
  gotoBox(Math.floor((sp.dex - 1) / BOX_SIZE));
  const slot = els.boxGrid.querySelector(`.slot[data-dex="${sp.dex}"]`);
  if (slot) {
    slot.classList.add("slot-flash");
    slot.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => slot.classList.remove("slot-flash"), 1600);
  }
}
function jumpToMon(raw, silent) {
  const sp = findSpecies(raw);
  if (!sp) { if (!silent && String(raw || "").trim()) alert(`No species matching "${raw}".`); return; }
  jumpToSpecies(sp);
}
// Exact match only — used on the `input` event so picking a datalist suggestion
// jumps immediately, without jumping on every partial keystroke.
function exactSpecies(raw) {
  const q = String(raw || "").trim().toLowerCase().replace(/^#/, "");
  if (!q) return null;
  return SPECIES.find((s) => s.name === q) || (/^\d+$/.test(q) ? DEX_BY_NUM[Number(q)] : null) || null;
}
function gotoFirstGap() {
  const miss = SPECIES.find((sp) => dexState(sp.dex) !== "boxed");
  if (!miss) { alert("Living dex complete — every species boxed! ✨"); return; }
  gotoBox(Math.floor((miss.dex - 1) / BOX_SIZE));
}

/* ---------- mega/gmax tab ---------- */
function formCard(form) {
  const unlocked = !!state.forms[form.id];
  const el = document.createElement("div");
  el.className = `mon ${unlocked ? "f-unlocked" : "f-locked"}`;
  el.dataset.form = form.id;
  el.title = form.label;
  el.innerHTML =
    `${unlocked ? `<span class="badge">✓</span>` : ""}` +
    `<img loading="lazy" src="${spriteUrl(form.dex, unlocked)}" alt="${form.label}" />` +
    `<div class="nm">${form.label}</div>`;
  return el;
}
function renderForms() {
  for (const kind of ["mega", "primal", "gmax"]) {
    const grid = document.getElementById(`forms-grid-${kind}`);
    grid.innerHTML = "";
    const frag = document.createDocumentFragment();
    FORMS[kind].forEach((f) => frag.appendChild(formCard(f)));
    grid.appendChild(frag);
  }
  renderFormsStats();
}
function renderFormsStats() {
  const all = [...FORMS.mega, ...FORMS.primal, ...FORMS.gmax];
  const have = all.filter((f) => state.forms[f.id]).length;
  const pct = ((have / all.length) * 100).toFixed(0);
  els.formsStats.innerHTML =
    `<span class="stat"><b>${have}</b>/${all.length} forms unlocked (${pct}%)</span>` +
    `<div class="bar"><i style="width:${pct}%"></i></div>` +
    `<span class="stat">Mega ${FORMS.mega.filter(f=>state.forms[f.id]).length}/${FORMS.mega.length}</span>` +
    `<span class="stat">GMax ${FORMS.gmax.filter(f=>state.forms[f.id]).length}/${FORMS.gmax.length}</span>`;
}

/* ---------- variants tab (regional + cosmetic forms) ---------- */
const VARIANT_GROUPS = [
  ["alolan", "Alolan"], ["galarian", "Galarian"], ["hisuian", "Hisuian"], ["paldean", "Paldean"],
];
function allVariants() {
  if (!VARIANTS) return [];
  return [...VARIANTS.regional.alolan, ...VARIANTS.regional.galarian,
    ...VARIANTS.regional.hisuian, ...VARIANTS.regional.paldean,
    ...VARIANTS.cosmetic, ...(VARIANTS.unown || []), ...(VARIANTS.cobblemon || [])];
}
// Variant art for a given shininess. Cobblemon-original variants use the wiki
// render; regional/cosmetic use Showdown by slug; the base national-dex sprite
// (matching shininess) is the fallback for anything without a distinct image.
function variantArt(v, shiny) {
  const fb = spriteUrl(v.dex, shiny);
  if (v.wikiFile) {
    if (shiny) return { src: v.wikiFileShiny ? WIKI_FILEPATH(v.wikiFileShiny) : fb, fb };
    return { src: WIKI_FILEPATH(v.wikiFile), fb };
  }
  if (v.slug) return { src: `${shiny ? SHOWDOWN_SHINY_BASE : SHOWDOWN_BASE}/${v.slug}.png`, fb };
  return { src: fb, fb };
}
// Match a spawn entry's form (e.g. "Galarian", "Blue-Striped") to a tracked variant
// so the card can show that variant's art. Keyed by dex + normalized aspect/name.
let VARIANT_BY_DEXFORM = null, VARIANT_BY_ID = {};
function allVariantObjs() {
  if (!VARIANTS) return [];
  return [...Object.values(VARIANTS.regional || {}).flat(), ...(VARIANTS.cosmetic || []), ...(VARIANTS.unown || []), ...(VARIANTS.cobblemon || [])];
}
function buildVariantLookup() {
  VARIANT_BY_DEXFORM = {};
  VARIANT_BY_ID = {};
  if (!VARIANTS) return;
  for (const v of allVariantObjs()) VARIANT_BY_ID[v.id] = v;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const add = (v) => {
    for (const t of new Set([norm(v.name), ...(v.aspects || []).map(norm)])) {
      const k = v.dex + "|" + t;
      if (t && !(k in VARIANT_BY_DEXFORM)) VARIANT_BY_DEXFORM[k] = v;
    }
  };
  for (const grp of Object.values(VARIANTS.regional || {})) (grp || []).forEach(add);
  (VARIANTS.cosmetic || []).forEach(add);
  (VARIANTS.unown || []).forEach(add);
  (VARIANTS.cobblemon || []).forEach(add);
}
function spawnVariant(dex, form) {
  if (!form || !VARIANT_BY_DEXFORM) return null;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  return VARIANT_BY_DEXFORM[dex + "|" + norm(form)]
    || VARIANT_BY_DEXFORM[dex + "|" + norm(String(form).split(" / ")[0])] // compound "A / B" → first
    || null;
}
// Card sprite for a spawn entry: the variant's render if the entry is a variant
// form (and one is tracked), else the base sprite. Name & dex stay the base.
function spawnCardArt(dex, entry, shiny) {
  const v = entry && entry.f ? spawnVariant(dex, entry.f) : null;
  if (v) return variantArt(v, !!shiny);
  const s = spriteUrl(dex, shiny);
  return { src: s, fb: s };
}
// State per variant: absent = none, true = caught, "shiny" = caught shiny.
// Click cycles none -> caught -> shiny -> none.
function variantCard(v) {
  const st = state.variants[v.id];
  const shiny = st === "shiny";
  const have = !!st;
  const el = document.createElement("div");
  el.className = `mon ${have ? "f-unlocked" : "f-locked"}${shiny ? " f-shiny" : ""}`;
  el.dataset.variant = v.id;
  el.title = `${v.base} · ${v.name}`;
  const { src, fb } = variantArt(v, shiny);
  const wished = (state.variantWishlist || []).includes(v.id);
  el.innerHTML =
    `${have ? `<span class="badge">${shiny ? "✨" : "✓"}</span>` : ""}` +
    `<button class="mon-hunt v-hunt" data-variant="${v.id}" title="Start a hunt for ${v.base} ${v.name}">🎯 Hunt</button>` +
    `<button class="mon-star v-star${wished ? " on" : ""}" data-variant="${v.id}" title="${wished ? "Remove from" : "Add to"} wishlist" aria-label="${wished ? "Remove from" : "Add to"} wishlist">${wished ? "★" : "☆"}</button>` +
    `<img loading="lazy" src="${src}" onerror="this.onerror=null;this.src='${fb}'" alt="${v.base} ${v.name}" />` +
    `<div class="dexno">#${String(v.dex).padStart(4, "0")}</div>` +
    `<div class="nm">${v.base.replace(/-/g, " ")}</div>` +
    `<div class="vform">${v.name}</div>`;
  return el;
}
function variantMatch(v) {
  const q = els.variantSearch.value.trim().toLowerCase().replace(/^#/, "");
  if (!q) return true;
  return v.base.toLowerCase().includes(q) || v.name.toLowerCase().includes(q) || String(v.dex) === q;
}
function renderVariantGrid(id, list) {
  const grid = document.getElementById(id);
  grid.innerHTML = "";
  const frag = document.createDocumentFragment();
  list.filter(variantMatch).forEach((v) => frag.appendChild(variantCard(v)));
  grid.appendChild(frag);
}
function renderVariants() {
  if (!VARIANTS) return;
  for (const [key] of VARIANT_GROUPS) renderVariantGrid(`variants-grid-${key}`, VARIANTS.regional[key]);
  renderVariantGrid("variants-grid-cosmetic", VARIANTS.cosmetic);
  renderVariantGrid("variants-grid-unown", VARIANTS.unown || []);
  renderVariantGrid("variants-grid-cobblemon", VARIANTS.cobblemon || []);
  renderVariantsStats();
}
function renderVariantsStats() {
  const all = allVariants();
  const have = all.filter((v) => state.variants[v.id]).length;
  const shinyHave = all.filter((v) => state.variants[v.id] === "shiny").length;
  const pct = all.length ? ((have / all.length) * 100).toFixed(0) : 0;
  const regional = [...VARIANTS.regional.alolan, ...VARIANTS.regional.galarian,
    ...VARIANTS.regional.hisuian, ...VARIANTS.regional.paldean];
  const regHave = regional.filter((v) => state.variants[v.id]).length;
  const cob = VARIANTS.cobblemon || [];
  const unown = VARIANTS.unown || [];
  els.variantsStats.innerHTML =
    `<span class="stat"><b>${have}</b>/${all.length} caught (${pct}%)</span>` +
    `<span class="stat">✨ <b>${shinyHave}</b> shiny</span>` +
    `<div class="bar"><i style="width:${pct}%"></i></div>` +
    `<span class="stat">Regional ${regHave}/${regional.length}</span>` +
    `<span class="stat">Cosmetic ${VARIANTS.cosmetic.filter((v) => state.variants[v.id]).length}/${VARIANTS.cosmetic.length}</span>` +
    `<span class="stat">Unown ${unown.filter((v) => state.variants[v.id]).length}/${unown.length}</span>` +
    `<span class="stat">Cobblemon ${cob.filter((v) => state.variants[v.id]).length}/${cob.length}</span>`;
}

/* ---------- legendary tab (shiny tracker + summon/reset calculator) ---------- */
function legName(dex) {
  const sp = DEX_BY_NUM[dex];
  return sp ? sp.name.replace(/-/g, " ") : "#" + dex;
}
// State per legendary: absent = none, true = caught, "shiny" = caught shiny.
function legendCard(e) {
  const st = state.legendaries[e.dex];
  const shiny = st === "shiny";
  const have = !!st;
  const el = document.createElement("div");
  el.className = `mon ${have ? "f-unlocked" : "f-locked"}${shiny ? " f-shiny" : ""}`;
  el.dataset.legDex = e.dex;
  const struct = (e.struct || []).join(", ");
  const nm = legName(e.dex);
  const wished = state.wishlist.includes(e.dex);
  el.title = `${nm} — ${e.sys}${struct ? `\n🏛 ${struct}` : ""}${e.note ? `\n${e.note}` : ""}`;
  el.innerHTML =
    `${have ? `<span class="badge">${shiny ? "✨" : "✓"}</span>` : ""}` +
    `<button class="mon-hunt" title="Start a hunt for ${nm}" aria-label="Start a hunt for ${nm}">🎯</button>` +
    `<button class="mon-star${wished ? " on" : ""}" title="${wished ? "Remove from" : "Add to"} favorites (wishlist)" aria-label="${wished ? "Remove from" : "Add to"} favorites for ${nm}">${wished ? "★" : "☆"}</button>` +
    `<button class="mon-info" title="Details, spawns & dex state for ${nm}" aria-label="Details for ${nm}">ⓘ</button>` +
    `<img loading="lazy" src="${spriteUrl(e.dex, shiny)}" alt="${nm}" />` +
    `<div class="dexno">#${String(e.dex).padStart(4, "0")}</div>` +
    `<div class="nm">${nm}</div>`;
  return el;
}
function renderLegendary() {
  if (!LEGENDS) return;
  const wrap = document.getElementById("legendary-groups");
  if (!wrap) return;
  wrap.innerHTML = "";
  for (const t of LEGENDS.tiers) {
    const entries = LEGENDS.list.filter((e) => e.tier === t.key);
    if (!entries.length) continue;
    const have = entries.filter((e) => state.legendaries[e.dex]).length;
    const shinyN = entries.filter((e) => state.legendaries[e.dex] === "shiny").length;
    const sec = document.createElement("div");
    sec.className = "leg-tier";
    const head = document.createElement("div");
    head.className = "leg-tier-head";
    head.innerHTML = `<h2 class="section-h">${t.icon} ${t.label}
        <span class="muted" style="font-weight:400">· ✨ ${shinyN} / ${entries.length} shiny · ${have} caught</span></h2>
      <p class="hint" style="margin:-4px 0 8px">${t.desc}</p>`;
    sec.appendChild(head);
    const grid = document.createElement("div");
    grid.className = "grid";
    const frag = document.createDocumentFragment();
    entries.forEach((e) => frag.appendChild(legendCard(e)));
    grid.appendChild(frag);
    sec.appendChild(grid);
    wrap.appendChild(sec);
  }
  renderLegendaryStats();
}
function renderLegendaryStats() {
  if (!LEGENDS) return;
  const all = LEGENDS.list;
  const have = all.filter((e) => state.legendaries[e.dex]).length;
  const shinyN = all.filter((e) => state.legendaries[e.dex] === "shiny").length;
  const pct = all.length ? ((shinyN / all.length) * 100).toFixed(0) : 0;
  els.legendaryStats.innerHTML =
    `<span class="stat">✨ <b>${shinyN}</b>/${all.length} shiny (${pct}%)</span>` +
    `<div class="bar"><i style="width:${pct}%"></i></div>` +
    `<span class="stat"><b>${have}</b> caught</span>` +
    LEGENDS.tiers.map((t) => {
      const es = all.filter((e) => e.tier === t.key);
      const s = es.filter((e) => state.legendaries[e.dex] === "shiny").length;
      return es.length ? `<span class="stat">${t.icon} ${s}/${es.length}</span>` : "";
    }).join("");
}
// Geometric distribution: independent rolls at p = 1/denom. Returns the summon
// count by which you have a 50/90/99% chance of at least one shiny, plus the mean.
function legShinyMath(denom) {
  const p = 1 / denom;
  const q = 1 - p;
  const at = (chance) => Math.ceil(Math.log(1 - chance) / Math.log(q));
  return { p, mean: denom, p50: at(0.5), p90: at(0.9), p99: at(0.99) };
}
function legLocateChip(id) {
  return `<span class="struct-chip leg-locate" data-locate="${id}" title="Copy /locate command">🏛 ${id}</span>`;
}
function renderLegCalc() {
  const denom = Math.max(1, Math.floor(Number(els.legCalcRate.value) || 50));
  const dex = els.legCalcTarget.value ? Number(els.legCalcTarget.value) : null;
  const e = dex ? LEGEND_BY_DEX[dex] : null;
  const m = legShinyMath(denom);
  const pctStr = (m.p * 100).toFixed(m.p * 100 < 1 ? 2 : 1) + "%";
  const tier = e ? LEGENDS.tiers.find((t) => t.key === e.tier) : null;
  // The "attempt" unit depends on how you re-roll: a fresh structure for one-time
  // loot, otherwise just another summon.
  const unit = tier && tier.farm === "reset" ? "fresh structures" : "summons";
  let head = `<div><b>${pctStr}</b> shiny per summon (1 / ${denom}) — independent rolls, no pity.</div>`;
  let farmLine = "";
  if (e) {
    head = `<div class="leg-calc-target"><img src="${spriteUrl(dex, true)}" alt=""/>
      <span><b>${legName(dex)}</b> — ${e.sys}<br><span class="muted">${tier ? tier.icon + " " + tier.label : ""}</span></span></div>` + head;
    if (tier && tier.farm === "reset")
      farmLine = `<p class="hint">🗝️ One-time loot — each shiny attempt needs a <b>newly generated structure</b>. This is a resource-world reset target: regenerate, re-summon, repeat.</p>`;
    else if (tier && tier.farm === "none")
      farmLine = `<p class="hint">🧩 Quest-gated — typically <b>one summon per playthrough</b>, so the 2% is effectively one-and-done; a reset won't re-arm it. (Verify whether the spawner re-triggers on your server.)</p>`;
    else if (tier && tier.farm === "infinite")
      farmLine = `<p class="hint">♻️ Free re-summon — just re-trigger the spawner until shiny. The counts below are how many tries that takes.</p>`;
    else if (tier && tier.farm === "mine")
      farmLine = `<p class="hint">⛏️ Renewable — each attempt costs one mineable gating item, so "summons" below = items to farm.</p>`;
    if (e.struct && e.struct.length)
      farmLine += `<div class="leg-structs">Find it: ${e.struct.map(legLocateChip).join(" ")}</div>`;
    if (e.note) farmLine += `<p class="hint" style="margin:6px 0 0">${e.note}</p>`;
  }
  els.legCalcOut.innerHTML = head +
    `<table class="odds-table"><tbody>
      <tr><td>Expected (average)</td><td><b>${m.mean.toLocaleString()}</b> ${unit}</td></tr>
      <tr><td>50% chance by</td><td><b>${m.p50.toLocaleString()}</b> ${unit}</td></tr>
      <tr><td>90% chance by</td><td><b>${m.p90.toLocaleString()}</b> ${unit}</td></tr>
      <tr><td>99% chance by</td><td><b>${m.p99.toLocaleString()}</b> ${unit}</td></tr>
    </tbody></table>` + farmLine;
}

/* ---------- berries tab (reference + collection tracking + mutation trees) ---------- */
let berryFilter = "all";
let GUIDE_BY_ID = {};
function indexBerryGuide() { GUIDE_BY_ID = {}; for (const b of BERRY_GUIDE) GUIDE_BY_ID[b.id] = b; }

// "Oran + (Cheri / Chesto / Pecha)" -> [["oran"], ["cheri","chesto","pecha"]]
function berryParents(source) {
  return String(source).split(/\s+\+\s+/).map((p) => {
    p = p.trim();
    if (p[0] === "(") p = p.slice(1, -1);
    return p.split(/\s*\/\s*/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  });
}
// Shortest production tree for a berry, tracing each parent back to wild berries
// and, where a slot allows alternatives, choosing the cheapest one. `steps` =
// number of crossbreeds (mutation nodes) in the tree. Mutations form a DAG, so
// plain recursion is safe; subtrees are tiny.
function berryTree(id) {
  const b = GUIDE_BY_ID[id];
  if (!b) return { id, name: id, kind: "missing", steps: Infinity, children: [] };
  if (b.kind !== "mutation") return { id, name: b.name, kind: b.kind, biomes: b.biomes, steps: 0, children: [] };
  const children = berryParents(b.source).map((alts) => {
    let best = null;
    for (const alt of alts) {
      const t = berryTree(alt);
      if (!best || t.steps < best.steps) best = t;
    }
    return Object.assign({ altCount: alts.length }, best || { id: alts[0], name: alts[0], kind: "missing", steps: Infinity, children: [] });
  });
  const steps = 1 + children.reduce((s, c) => s + c.steps, 0);
  return { id, name: b.name, kind: "mutation", mulch: b.mulch, source: b.source, steps, children };
}
function berryTreeHtml(node) {
  const b = GUIDE_BY_ID[node.id];
  const img = b ? `<img src="${WIKI_FILEPATH(b.img)}" alt="" />` : "";
  const have = state.berries[node.id] ? " tr-have" : "";
  const alt = node.altCount > 1 ? ` <span class="tr-alt">(1 of ${node.altCount} options)</span>` : "";
  const tag = node.kind === "natural"
    ? `<span class="tr-tag">🌿 ${(b && b.biomes || []).join(", ")}</span>`
    : node.kind === "mutation"
      ? `<span class="tr-tag tr-recipe">⚗️ ${node.source}</span>` + (node.mulch ? ` <span class="tr-tag">🪣 ${node.mulch}</span>` : "")
      : "";
  const kids = node.children && node.children.length
    ? `<ul>${node.children.map(berryTreeHtml).join("")}</ul>` : "";
  return `<li class="${node.kind}${have}">${img}<b>${node.name}</b>${alt} ${tag}${kids}</li>`;
}
function openBerryTree(id) {
  const b = GUIDE_BY_ID[id];
  if (!b || b.kind !== "mutation") return;
  const tree = berryTree(id);
  const s = tree.steps;
  document.getElementById("berry-modal-body").innerHTML =
    `<h2>${b.name} — shortest mutation path</h2>` +
    `<p class="hint">${s} crossbreed${s === 1 ? "" : "s"} from wild berries. Plant each pair in orthogonally ` +
    `adjacent tiles (not diagonal); ~12.5% chance per harvest (raise it with Surprise Mulch).</p>` +
    `<ul class="berry-tree">${berryTreeHtml(tree)}</ul>`;
  document.getElementById("berry-modal").hidden = false;
}
function berryCard(b) {
  const how = b.kind === "natural"
    ? `<span class="b-tag">🌿 ${b.biomes.join(", ")}</span>` +
      (b.mulch ? `<span class="b-tag b-mulch">🪣 ${b.mulch}</span>` : "")
    : `<span class="b-tag b-recipe">⚗️ ${b.source}</span>` +
      (b.mulch ? `<span class="b-tag b-mulch">🪣 ${b.mulch}</span>` : "") +
      `<button class="b-tree" data-tree="${b.id}" title="Show shortest mutation path">🌳 tree</button>`;
  const have = !!state.berries[b.id];
  const el = document.createElement("div");
  el.className = `berry b-${b.kind}${have ? " tracked" : ""}`;
  el.dataset.berry = b.id;
  el.innerHTML =
    `<img loading="lazy" src="${WIKI_FILEPATH(b.img)}" alt="${b.name}" />` +
    `<div class="b-main">` +
      `<div class="b-name">${b.name}${have ? ` <span class="b-check">✓</span>` : ""}</div>` +
      `<div class="b-effect">${b.effect}</div>` +
      `<div class="b-how">${how}</div>` +
    `</div>`;
  return el;
}
function berryMatch(b, q) {
  if (!q) return true;
  return [b.name, b.effect, b.source, ...(b.biomes || []), b.mulch]
    .join(" ").toLowerCase().includes(q);
}
function renderBerries() {
  const host = document.getElementById("berries-list");
  if (!host) return;
  if (!Object.keys(GUIDE_BY_ID).length) indexBerryGuide();
  const q = (els.berrySearch && els.berrySearch.value.trim().toLowerCase()) || "";
  // Single alphabetical list; the chips narrow by kind, not split into sections.
  const list = BERRY_GUIDE
    .filter((b) => (berryFilter === "all" || b.kind === berryFilter) && berryMatch(b, q))
    .slice().sort((a, b) => a.name.localeCompare(b.name));
  host.innerHTML = "";
  if (!list.length) { host.innerHTML = `<p class="hint">No berries match.</p>`; renderBerriesStats(); return; }
  const grid = document.createElement("div");
  grid.className = "berry-grid";
  list.forEach((b) => grid.appendChild(berryCard(b)));
  host.appendChild(grid);
  renderBerriesStats();
}
function renderBerriesStats() {
  if (!els.berriesStats) return;
  const n = (k) => BERRY_GUIDE.filter((b) => b.kind === k).length;
  const have = BERRY_GUIDE.filter((b) => state.berries[b.id]).length;
  const pct = BERRY_GUIDE.length ? ((have / BERRY_GUIDE.length) * 100).toFixed(0) : 0;
  els.berriesStats.innerHTML =
    `<span class="stat"><b>${have}</b>/${BERRY_GUIDE.length} collected (${pct}%)</span>` +
    `<div class="bar"><i style="width:${pct}%"></i></div>` +
    `<span class="stat">🌿 ${n("natural")} wild</span>` +
    `<span class="stat">⚗️ ${n("mutation")} mutation</span>`;
}

/* ---------- party builder tab ---------- */
// [statUp, statDown]; empty = neutral nature.
const NATURES = {
  Hardy: [], Lonely: ["atk", "def"], Brave: ["atk", "spe"], Adamant: ["atk", "spa"], Naughty: ["atk", "spd"],
  Bold: ["def", "atk"], Docile: [], Relaxed: ["def", "spe"], Impish: ["def", "spa"], Lax: ["def", "spd"],
  Timid: ["spe", "atk"], Hasty: ["spe", "def"], Serious: [], Jolly: ["spe", "spa"], Naive: ["spe", "spd"],
  Modest: ["spa", "atk"], Mild: ["spa", "def"], Quiet: ["spa", "spe"], Bashful: [], Rash: ["spa", "spd"],
  Calm: ["spd", "atk"], Gentle: ["spd", "def"], Sassy: ["spd", "spe"], Careful: ["spd", "spa"], Quirky: [],
};
const NATURE_NAMES = Object.keys(NATURES);
const EV_CAP = 252, EV_TOTAL = 510, IV_MAX = 31;
const STAT_LABEL = Object.fromEntries(STATS);

function activeParty() {
  return state.party.list.find((p) => p.id === state.party.active) || state.party.list[0];
}
function evSum(m) { return STATS.reduce((s, [k]) => s + (m.evs[k] || 0), 0); }
function natureBlurb(name) {
  const n = NATURES[name];
  if (!n || !n.length) return "—";
  return `+${STAT_LABEL[n[0]]} −${STAT_LABEL[n[1]]}`;
}
function clampInt(v, lo, hi) { v = Math.round(Number(v) || 0); return Math.max(lo, Math.min(hi, v)); }
// Common competitive held items for the slot autocomplete. Not exhaustive — the
// input is free-text, so any item the modpack adds can still be typed in.
const HELD_ITEMS = [
  "Leftovers", "Life Orb", "Choice Band", "Choice Specs", "Choice Scarf", "Focus Sash",
  "Assault Vest", "Rocky Helmet", "Eviolite", "Heavy-Duty Boots", "Black Sludge",
  "Sitrus Berry", "Lum Berry", "Expert Belt", "Muscle Band", "Wise Glasses", "Wide Lens",
  "Scope Lens", "Light Clay", "Mental Herb", "Power Herb", "Weakness Policy", "Throat Spray",
  "Air Balloon", "Toxic Orb", "Flame Orb", "Safety Goggles", "Red Card", "Eject Button",
  "Shell Bell", "Big Root", "Quick Claw", "King's Rock", "Bright Powder", "Loaded Dice",
  "Covert Cloak", "Clear Amulet", "Booster Energy", "Mirror Herb", "Punching Glove",
  "Metronome", "Berry Juice", "Razor Claw",
];
// The coach's one-item pick for a computed build: walls want passive recovery,
// attackers want a flat damage boost.
function recommendedItem(role) { return /wall/.test(role) ? "Leftovers" : "Life Orb"; }
function movepool(dex) { return (COACH[dex] && COACH[dex].moves) || []; }
// The coach's recommended ability (hidden, else the first) — auto-applied on add.
function recommendedAbility(dex) { const c = COACH[dex]; return c ? (c.hidden || c.abilities[0] || "") : ""; }
function moveOk(pool, name) { return !pool.length || !name || pool.includes(name); }

function memberCardHtml(m, slot) {
  const sp = m.dex ? DEX_BY_NUM[m.dex] : null;
  const sprite = sp ? `<img src="${spriteUrl(sp.dex, false)}" alt="" />` : `<span class="pm-empty">＋</span>`;
  const types = sp ? sp.types.map((t) => `<span class="ptype t-${t}">${t}</span>`).join("") : "";
  const natOpts = `<option value="">Nature…</option>` + NATURE_NAMES.map((n) =>
    `<option value="${n}"${m.nature === n ? " selected" : ""}>${n} (${natureBlurb(n)})</option>`).join("");
  const abils = sp && COACH[sp.dex] ? COACH[sp.dex].abilities : [];
  const abilOpts = `<option value="">Ability…</option>` + abils.map((a) =>
    `<option value="${a}"${m.ability === a ? " selected" : ""}>${a}</option>`).join("");
  // Per-species legal-move autocomplete; the global list is the fallback.
  const pool = sp ? movepool(sp.dex) : [];
  const listId = pool.length ? `moves-p${slot}` : "moves-list";
  const moves = [0, 1, 2, 3].map((i) => {
    const v = m.moves[i] || "";
    const bad = v && !moveOk(pool, v) ? " illegal" : "";
    return `<input class="pm-move${bad}" list="${listId}" data-slot="${slot}" data-k="move" data-i="${i}" ` +
      `value="${v}" placeholder="Move ${i + 1}" />`;
  }).join("");
  const poolList = pool.length ? `<datalist id="moves-p${slot}">${pool.map((n) => `<option value="${n}">`).join("")}</datalist>` : "";
  const total = evSum(m);
  const evRow = STATS.map(([k, lbl]) =>
    `<label class="pm-stat"><span>${lbl}</span><input type="number" min="0" max="${EV_CAP}" ` +
    `data-slot="${slot}" data-k="ev" data-stat="${k}" value="${m.evs[k]}" /></label>`).join("");
  const ivRow = STATS.map(([k, lbl]) =>
    `<label class="pm-stat"><span>${lbl}</span><input type="number" min="0" max="${IV_MAX}" ` +
    `data-slot="${slot}" data-k="iv" data-stat="${k}" value="${m.ivs[k]}" /></label>`).join("");
  return `<div class="pm-card" data-slot="${slot}">` +
    `<div class="pm-head">` +
      `<div class="pm-sprite">${sprite}</div>` +
      `<div class="pm-id">` +
        `<input class="pm-species" list="species-list" data-slot="${slot}" data-k="species" ` +
          `value="${sp ? sp.name : ""}" placeholder="Slot ${slot + 1} — species…" />` +
        `<div class="pm-types">${types}</div>` +
      `</div>` +
      `<div class="pm-btns">` +
        (sp ? `<button class="pm-coach" data-slot="${slot}" data-act="coach" title="Coach — suggest a build">🎓</button>` : "") +
        `<button class="pm-clear" data-slot="${slot}" data-act="clear" title="Clear slot">✕</button>` +
      `</div>` +
    `</div>` +
    `<div class="pm-row">` +
      `<select class="pm-nature" data-slot="${slot}" data-k="nature">${natOpts}</select>` +
      `<select class="pm-ability" data-slot="${slot}" data-k="ability">${abilOpts}</select>` +
    `</div>` +
    `<input class="pm-item" list="held-items-list" data-slot="${slot}" data-k="item" ` +
      `value="${(m.item || "").replace(/"/g, "&quot;")}" placeholder="🎁 Held item…" />` +
    `<div class="pm-moves">${moves}</div>${poolList}` +
    `<div class="pm-block">` +
      `<div class="pm-block-h">EVs <span class="pm-evtotal${total > EV_TOTAL ? " over" : ""}" data-slot="${slot}">${total}/510</span>` +
        `<button class="pm-mini" data-slot="${slot}" data-act="ev0">clear</button></div>` +
      `<div class="pm-stats">${evRow}</div>` +
    `</div>` +
    `<div class="pm-block">` +
      `<div class="pm-block-h">IVs <span class="muted">0–31</span>` +
        `<button class="pm-mini" data-slot="${slot}" data-act="ivmax">max</button>` +
        `<button class="pm-mini" data-slot="${slot}" data-act="iv0">0</button></div>` +
      `<div class="pm-stats">${ivRow}</div>` +
    `</div>` +
  `</div>`;
}
function renderParty() {
  const host = document.getElementById("party-body");
  if (!host) return;
  const sel = document.getElementById("party-select");
  if (sel) sel.innerHTML = state.party.list.map((p) =>
    `<option value="${p.id}"${p.id === state.party.active ? " selected" : ""}>${p.name} (${p.members.filter((m) => m.dex).length}/6)</option>`).join("");
  const party = activeParty();
  host.innerHTML = `<div class="pm-grid">${party.members.map(memberCardHtml).join("")}</div>`;
}
// Update only the small derived bits after an inline edit (keeps input focus).
function refreshMemberDerived(slot) {
  const m = activeParty().members[slot];
  const card = document.querySelector(`.pm-card[data-slot="${slot}"]`);
  if (!card) return;
  const sp = m.dex ? DEX_BY_NUM[m.dex] : null;
  card.querySelector(".pm-sprite").innerHTML = sp ? `<img src="${spriteUrl(sp.dex, false)}" alt="" />` : `<span class="pm-empty">＋</span>`;
  card.querySelector(".pm-types").innerHTML = sp ? sp.types.map((t) => `<span class="ptype t-${t}">${t}</span>`).join("") : "";
  // Re-point move autocomplete at the new species' legal pool + re-flag illegals.
  const pool = sp ? movepool(sp.dex) : [];
  const listId = pool.length ? `moves-p${slot}` : "moves-list";
  let dl = card.querySelector(`#moves-p${slot}`);
  if (pool.length) {
    if (!dl) { dl = document.createElement("datalist"); dl.id = `moves-p${slot}`; card.appendChild(dl); }
    dl.innerHTML = pool.map((n) => `<option value="${n}">`).join("");
  } else if (dl) { dl.remove(); }
  card.querySelectorAll(".pm-move").forEach((inp) => {
    inp.setAttribute("list", listId);
    inp.classList.toggle("illegal", !!inp.value && !moveOk(pool, inp.value));
  });
  // Repopulate ability options for the new species.
  const abilSel = card.querySelector(".pm-ability");
  if (abilSel) {
    const abils = sp && COACH[sp.dex] ? COACH[sp.dex].abilities : [];
    abilSel.innerHTML = `<option value="">Ability…</option>` + abils.map((a) =>
      `<option value="${a}"${m.ability === a ? " selected" : ""}>${a}</option>`).join("");
  }
  // Show/hide the Coach button to match whether a species is set.
  const btns = card.querySelector(".pm-btns");
  let coachBtn = btns.querySelector(".pm-coach");
  if (sp && !coachBtn) btns.insertAdjacentHTML("afterbegin", `<button class="pm-coach" data-slot="${slot}" data-act="coach" title="Coach — suggest a build">🎓</button>`);
  else if (!sp && coachBtn) coachBtn.remove();
  const total = evSum(m);
  const tEl = card.querySelector(".pm-evtotal");
  tEl.textContent = `${total}/510`;
  tEl.classList.toggle("over", total > EV_TOTAL);
}

function partyEdit(slot, k, payload) {
  const m = activeParty().members[slot];
  // On (re)assigning a species, auto-pick its recommended ability so you don't
  // have to apply the coach's ability tip every time. Nature/EVs/moves untouched.
  if (k === "species") { const sp = findSpecies(payload); const d = sp ? sp.dex : null; if (d !== m.dex) m.ability = d ? recommendedAbility(d) : ""; m.dex = d; }
  else if (k === "nature") m.nature = payload;
  else if (k === "ability") m.ability = payload;
  else if (k === "item") m.item = payload;
  else if (k === "move") m.moves[payload.i] = payload.value;
  else if (k === "ev") m.evs[payload.stat] = clampInt(payload.value, 0, EV_CAP);
  else if (k === "iv") m.ivs[payload.stat] = clampInt(payload.value, 0, IV_MAX);
  save();
}
function partyAction(slot, act) {
  const m = activeParty().members[slot];
  if (act === "clear") activeParty().members[slot] = emptyMember();
  else if (act === "ev0") for (const [s] of STATS) m.evs[s] = 0;
  else if (act === "ivmax") for (const [s] of STATS) m.ivs[s] = IV_MAX;
  else if (act === "iv0") for (const [s] of STATS) m.ivs[s] = 0;
  save();
  renderParty();
}

// ---- party management ----
function selectParty(id) { state.party.active = id; save(); renderParty(); }
function addParty() {
  const name = (prompt("Name this party:", `Party ${state.party.list.length + 1}`) || "").trim();
  if (name === null) return;
  const p = newParty(name || `Party ${state.party.list.length + 1}`);
  state.party.list.push(p); state.party.active = p.id; save(); renderParty();
}
function renameParty() {
  const p = activeParty();
  const name = prompt("Rename party:", p.name);
  if (name == null) return;
  p.name = name.trim() || p.name; save(); renderParty();
}
function deleteParty() {
  if (state.party.list.length <= 1) { alert("Keep at least one party."); return; }
  const p = activeParty();
  if (!confirm(`Delete "${p.name}"?`)) return;
  state.party.list = state.party.list.filter((x) => x.id !== p.id);
  state.party.active = state.party.list[0].id; save(); renderParty();
}

// ---- random generator ----
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomMovesFor(sp) {
  // Only legal moves for this species; bias toward its STAB damaging moves.
  const legal = movepool(sp.dex);
  const meta = legal.map((n) => MOVE_BY_NAME[n]).filter(Boolean);
  const typed = meta.filter((mv) => sp.types.includes(mv.type.toLowerCase()) && mv.category !== "Status").map((m) => m.name);
  const names = typed.length >= 4 ? typed
    : meta.length >= 4 ? meta.map((m) => m.name)
      : legal.length ? legal : MOVES.map((m) => m.name);
  const chosen = [];
  let guard = 0;
  while (chosen.length < 4 && names.length && guard++ < 300) {
    const mv = pick(names);
    if (!chosen.includes(mv)) chosen.push(mv);
  }
  return chosen;
}
function randomEvs() {
  const ev = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  const keys = STATS.map(([k]) => k);
  // two maxed offensive/utility stats + a small 6 — a valid 510-cap spread.
  const a = pick(keys); let b = pick(keys); while (b === a) b = pick(keys);
  let c = pick(keys); while (c === a || c === b) c = pick(keys);
  ev[a] = 252; ev[b] = 252; ev[c] = 6;
  return ev;
}
function randomMemberFrom(sp) {
  const c = COACH[sp.dex];
  return {
    dex: sp.dex, nature: pick(NATURE_NAMES),
    ability: c && c.abilities.length ? pick(c.abilities) : "",
    item: (coachBuild(sp.dex) || {}).item || "Leftovers",
    moves: randomMovesFor(sp),
    evs: randomEvs(), ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  };
}
function randomMember() { return randomMemberFrom(pick(SPECIES)); }
// Smogon SV singles power order (high -> low). "Max OU"/"Max UU" act as a tier
// ceiling: include that tier and everything below it (so Max OU excludes Ubers).
const TIER_RANK = { AG: 13, Uber: 12, OU: 11, UUBL: 10, UU: 9, RUBL: 8, RU: 7, NUBL: 6, NU: 5, PUBL: 4, PU: 3, ZUBL: 2, ZU: 1 };
function tierMatch(dex, mode) {
  if (mode === "any") return true;
  const r = TIER_RANK[(COACH[dex] && COACH[dex].tier) || ""] || 0;
  if (!r) return false;                 // no standard tier (LC/NFE/unavailable) -> not in a capped pool
  if (mode === "ou") return r <= TIER_RANK.OU;
  if (mode === "uu") return r <= TIER_RANK.UU;
  return true;
}
function isLegendary(dex) { return !!(COACH[dex] && COACH[dex].leg); }
// Restrict the random-team draw to a source pool.
//  all          – every species with team data
//  owned        – ones you own (caught, shiny or boxed)
//  owned-shiny  – ones you own shiny (shiny or boxed)
//  wishlist     – your ★ wishlist
function teamPoolMatch(dex, pool) {
  const st = dexState(dex);
  if (pool === "owned") return st === "caught" || st === "shiny" || st === "boxed";
  if (pool === "owned-shiny") return st === "shiny" || st === "boxed";
  if (pool === "wishlist") return state.wishlist.includes(dex);
  return true;
}
function randomizeParty() {
  const pool = (document.getElementById("party-rand-pool") || {}).value || "all";
  const tier = (document.getElementById("party-rand-tier") || {}).value || "any";
  const legMode = (document.getElementById("party-rand-leg") || {}).value || "any";
  const poolLbl = { all: "", owned: " from your owned", "owned-shiny": " from your shinies", wishlist: " from your wishlist" }[pool];
  const tierLbl = { any: "any tier", ou: "max-OU", uu: "max-UU" }[tier];
  const legLbl = { any: "", "0": ", no legendaries", "1": ", 1 legendary" }[legMode];

  const haveCoach = (sp) => COACH[sp.dex];
  // Base pool: team data + source filter (owned / shiny / wishlist).
  const base = SPECIES.filter((sp) => haveCoach(sp) && teamPoolMatch(sp.dex, pool));
  if (!base.length) {
    alert(pool === "all"
      ? "No species have team data."
      : "Nothing in that pool has team data yet — catch some, or pick a different pool.");
    return;
  }
  if (!confirm(`Replace all 6 slots of "${activeParty().name}" with a random ${tierLbl} team${poolLbl}${legLbl}?`)) return;

  // Apply the tier ceiling within the pool, falling back to the whole pool if it empties.
  const tiered = base.filter((sp) => tierMatch(sp.dex, tier));
  const usable = tiered.length ? tiered : base;
  const nonLeg = usable.filter((sp) => !isLegendary(sp.dex));
  const used = new Set();
  const draw = (arr) => {
    const avail = arr.filter((sp) => !used.has(sp.dex));
    const sp = pick(avail.length ? avail : arr);
    used.add(sp.dex); return sp;
  };

  const slots = [];
  if (legMode === "1") {
    // Keep the legendary within the pool; if none qualify, just fill from the pool.
    const legPool = usable.filter((sp) => isLegendary(sp.dex));
    const legSrc = legPool.length ? legPool : base.filter((sp) => isLegendary(sp.dex));
    if (legSrc.length) {
      slots.push(draw(legSrc));
      const others = nonLeg.length ? nonLeg : usable;
      for (let i = 0; i < 5; i++) slots.push(draw(others));
    } else {
      for (let i = 0; i < 6; i++) slots.push(draw(nonLeg.length ? nonLeg : usable));
    }
  } else {
    const src = legMode === "0" ? (nonLeg.length ? nonLeg : usable) : usable;
    for (let i = 0; i < 6; i++) slots.push(draw(src));
  }
  activeParty().members = slots.map(randomMemberFrom);
  save(); renderParty();
}

/* ---------- coach (build suggestions, à la pocketcraft) ---------- */
const TYPES = ["normal", "fire", "water", "electric", "grass", "ice", "fighting", "poison",
  "ground", "flying", "psychic", "bug", "rock", "ghost", "dragon", "dark", "steel", "fairy"];
// Attacking type -> { defending type: multiplier } for non-1 matchups (Gen 6+).
const TYPE_CHART = {
  normal: { rock: .5, ghost: 0, steel: .5 },
  fire: { fire: .5, water: .5, grass: 2, ice: 2, bug: 2, rock: .5, dragon: .5, steel: 2 },
  water: { fire: 2, water: .5, grass: .5, ground: 2, rock: 2, dragon: .5 },
  electric: { water: 2, electric: .5, grass: .5, ground: 0, flying: 2, dragon: .5 },
  grass: { fire: .5, water: 2, grass: .5, poison: .5, ground: 2, flying: .5, bug: .5, rock: 2, dragon: .5, steel: .5 },
  ice: { fire: .5, water: .5, grass: 2, ice: .5, ground: 2, flying: 2, dragon: 2, steel: .5 },
  fighting: { normal: 2, ice: 2, poison: .5, flying: .5, psychic: .5, bug: .5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: .5 },
  poison: { grass: 2, poison: .5, ground: .5, rock: .5, ghost: .5, steel: 0, fairy: 2 },
  ground: { fire: 2, electric: 2, grass: .5, poison: 2, flying: 0, bug: .5, rock: 2, steel: 2 },
  flying: { electric: .5, grass: 2, fighting: 2, bug: 2, rock: .5, steel: .5 },
  psychic: { fighting: 2, poison: 2, psychic: .5, dark: 0, steel: .5 },
  bug: { fire: .5, grass: 2, fighting: .5, poison: .5, flying: .5, psychic: 2, ghost: .5, dark: 2, steel: .5, fairy: .5 },
  rock: { fire: 2, ice: 2, fighting: .5, ground: .5, flying: 2, bug: 2, steel: .5 },
  ghost: { normal: 0, psychic: 2, ghost: 2, dark: .5 },
  dragon: { dragon: 2, steel: .5, fairy: 0 },
  dark: { fighting: .5, psychic: 2, ghost: 2, dark: .5, fairy: .5 },
  steel: { fire: .5, water: .5, electric: .5, ice: 2, rock: 2, steel: .5, fairy: 2 },
  fairy: { fire: .5, fighting: 2, poison: .5, dragon: 2, dark: 2, steel: .5 },
};
function defenseProfile(types) {
  const mult = {};
  for (const atk of TYPES) {
    let x = 1;
    for (const def of types) x *= (TYPE_CHART[atk] && TYPE_CHART[atk][def] != null ? TYPE_CHART[atk][def] : 1);
    mult[atk] = x;
  }
  const weak = [], resist = [], immune = [];
  for (const t of TYPES) {
    const x = mult[t];
    if (x === 0) immune.push(t);
    else if (x > 1) weak.push([t, x]);
    else if (x < 1) resist.push([t, x]);
  }
  weak.sort((a, b) => b[1] - a[1]); resist.sort((a, b) => a[1] - b[1]);
  return { weak, resist, immune };
}
const NAT_FOR = { "def-atk": "Bold", "def-spa": "Impish", "spd-atk": "Calm", "spd-spa": "Careful" };
const UTIL_MOVES = ["Recover", "Roost", "Synthesis", "Moonlight", "Morning Sun", "Slack Off", "Soft-Boiled",
  "Wish", "Calm Mind", "Nasty Plot", "Swords Dance", "Dragon Dance", "Quiver Dance", "Bulk Up", "Iron Defense",
  "Toxic", "Will-O-Wisp", "Thunder Wave", "Stealth Rock", "Spikes", "Defog", "Rapid Spin", "Knock Off",
  "Protect", "Substitute", "Recover"];
// Recharge / 2-turn / self-KO moves: high base power but bad as default picks.
const BAD_MOVES = new Set(["Hyper Beam", "Giga Impact", "Frenzy Plant", "Blast Burn", "Hydro Cannon",
  "Roar of Time", "Rock Wrecker", "Prismatic Laser", "Eternabeam", "Meteor Assault", "Solar Beam", "Solar Blade",
  "Sky Attack", "Skull Bash", "Razor Wind", "Bounce", "Fly", "Dig", "Dive", "Phantom Force", "Shadow Force",
  "Freeze Shock", "Ice Burn", "Sky Drop", "Explosion", "Self-Destruct", "Misty Explosion", "Final Gambit",
  "Last Resort", "Synchronoise", "Electro Shot"]);
// Effective power discounts shaky accuracy so a 50%-acc nuke ranks below a reliable hit.
function effPower(m) { return m.power * (m.acc >= 100 ? 1 : m.acc / 100); }
function damaging(meta, cat) {
  return meta.filter((m) => m.category === cat && m.power > 0 && !BAD_MOVES.has(m.name));
}
function bestStab(meta, type, cat) {
  return damaging(meta, cat).filter((m) => m.type.toLowerCase() === type)
    .sort((a, b) => effPower(b) - effPower(a))[0];
}
function coachBuild(dex) {
  const c = COACH[dex], sp = DEX_BY_NUM[dex];
  if (!c || !sp) return null;
  const b = c.base;
  const offCat = b.atk >= b.spa ? "Physical" : "Special";
  const offStat = offCat === "Physical" ? "atk" : "spa";
  const maxOff = Math.max(b.atk, b.spa), bulk = b.hp + b.def + b.spd;
  const ivs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
  let role, nature, evs, why;

  if (maxOff >= 80 && maxOff * 1.1 >= bulk / 3) {
    const fast = b.spe >= 85;
    role = (b.spe >= 95 ? "Fast " : "") + (offCat === "Physical" ? "physical attacker" : "special attacker");
    nature = offCat === "Physical" ? (fast ? "Jolly" : "Adamant") : (fast ? "Timid" : "Modest");
    evs = { hp: 4, atk: 0, def: 0, spa: 0, spd: 0, spe: 252 }; evs[offStat] = 252;
    if (offCat === "Physical") ivs.spa = 0;
    why = `Best attack is ${offCat === "Physical" ? "Atk " + b.atk : "SpA " + b.spa} with ${b.spe} Speed — max it and outspeed. ${fast ? "Speed-boosting" : "Attack-boosting"} nature.`;
  } else {
    role = "defensive wall";
    const defSide = b.def >= b.spd ? "def" : "spd";
    const reduce = b.atk <= b.spa ? "atk" : "spa";
    evs = { hp: 252, atk: 0, def: 4, spa: 0, spd: 0, spe: 0 }; evs[defSide] = 252;
    nature = NAT_FOR[`${defSide}-${reduce}`];
    if (reduce === "atk") ivs.atk = 0;
    why = `Modest offense but good bulk (HP ${b.hp} / Def ${b.def} / SpD ${b.spd}) — invest HP and ${defSide === "def" ? "Defense" : "Sp. Def"}.`;
  }

  // Moves: STAB(s) + coverage; walls lead with a STAB then utility/recovery.
  const meta = c.moves.map((n) => MOVE_BY_NAME[n]).filter(Boolean);
  const picks = [], taken = new Set();
  const add = (name) => { if (name && !taken.has(name)) { taken.add(name); picks.push(name); } };
  for (const t of sp.types) { const s = bestStab(meta, t, offCat); if (s) add(s.name); }
  if (role === "defensive wall") {
    for (const u of UTIL_MOVES) { if (picks.length >= 4) break; if (c.moves.includes(u)) add(u); }
  } else {
    const cover = damaging(meta, offCat).filter((m) => !sp.types.includes(m.type.toLowerCase()))
      .sort((a, b2) => effPower(b2) - effPower(a));
    const seenType = new Set(sp.types);
    for (const m of cover) { if (picks.length >= 4) break; if (!seenType.has(m.type.toLowerCase())) { seenType.add(m.type.toLowerCase()); add(m.name); } }
    for (const u of UTIL_MOVES) { if (picks.length >= 4) break; if (c.moves.includes(u)) add(u); }
  }
  for (const m of damaging(meta, offCat).sort((a, b2) => effPower(b2) - effPower(a))) { if (picks.length >= 4) break; add(m.name); }

  const ability = c.hidden || c.abilities[0] || "";
  return { role, nature, evs, ivs, moves: picks.slice(0, 4), ability, item: recommendedItem(role), why, base: b, bst: c.bst, abilities: c.abilities, hidden: c.hidden };
}
function statBars(b) {
  return STATS.map(([k, lbl]) => {
    const v = b[k];
    const pct = Math.min(100, (v / 200) * 100);
    const hue = Math.round((Math.min(v, 150) / 150) * 120); // red->green
    return `<div class="cz-statrow"><span class="cz-statk">${lbl}</span>` +
      `<span class="cz-statv">${v}</span>` +
      `<span class="cz-bar"><i style="width:${pct}%;background:hsl(${hue} 70% 45%)"></i></span></div>`;
  }).join("");
}
let coachSlot = -1;
function openCoach(slot) {
  const m = activeParty().members[slot];
  if (!m || !m.dex) return;
  const build = coachBuild(m.dex);
  const sp = DEX_BY_NUM[m.dex];
  if (!build) return;
  coachSlot = slot;
  const def = defenseProfile(sp.types);
  const chip = (t, x) => `<span class="ptype t-${t}">${t}${x && x !== 1 && x !== 0 ? ` ×${x}` : ""}${x === 0 ? " ×0" : ""}</span>`;
  const evStr = STATS.filter(([k]) => build.evs[k]).map(([k, lbl]) => `${build.evs[k]} ${lbl}`).join(" / ") || "—";
  const moveChips = build.moves.map((n) => {
    const mv = MOVE_BY_NAME[n];
    return `<span class="cz-move${mv ? ` t-${mv.type.toLowerCase()}` : ""}">${n}</span>`;
  }).join("");
  document.getElementById("coach-modal-body").innerHTML =
    `<div class="cz-head"><img src="${spriteUrl(sp.dex, false)}" alt="" />` +
      `<div><h2>${sp.name}</h2><div class="pm-types">${sp.types.map((t) => `<span class="ptype t-${t}">${t}</span>`).join("")}` +
      `<span class="cz-bst">BST ${build.bst}</span></div>` +
      `<div class="muted" style="font-size:.78rem;margin-top:3px">Abilities: ${build.abilities.join(", ") || "—"}</div></div></div>` +
    `<div class="cz-stats">${statBars(build.base)}</div>` +
    `<h3 class="cz-h">Suggested build — <span class="cz-role">${build.role}</span></h3>` +
    `<p class="hint" style="margin:2px 0 8px">${build.why}</p>` +
    `<div class="cz-grid">` +
      `<div><b>Nature</b><br>${build.nature} <span class="muted">(${natureBlurb(build.nature)})</span></div>` +
      `<div><b>Ability</b><br>${build.ability || "—"}${build.hidden && build.ability === build.hidden ? ` <span class="muted">(hidden)</span>` : ""}</div>` +
      `<div><b>Held item</b><br>🎁 ${build.item}</div>` +
      `<div><b>EVs</b><br>${evStr}</div>` +
      `<div><b>IVs</b><br>${build.ivs.atk === 0 ? "0 Atk, rest 31" : build.ivs.spa === 0 ? "0 SpA, rest 31" : "All 31"}</div>` +
    `</div>` +
    `<div class="cz-moves">${moveChips}</div>` +
    `<button class="ctrl-btn good" id="coach-apply">Apply to slot ${slot + 1}</button>` +
    `<h3 class="cz-h">Type defense</h3>` +
    `<div class="cz-def">` +
      (def.weak.length ? `<div><span class="cz-lbl wk">Weak</span> ${def.weak.map(([t, x]) => chip(t, x)).join("")}</div>` : "") +
      (def.resist.length ? `<div><span class="cz-lbl rs">Resists</span> ${def.resist.map(([t, x]) => chip(t, x)).join("")}</div>` : "") +
      (def.immune.length ? `<div><span class="cz-lbl im">Immune</span> ${def.immune.map((t) => chip(t, 0)).join("")}</div>` : "") +
    `</div>`;
  document.getElementById("coach-modal").hidden = false;
}
function applyCoach() {
  if (coachSlot < 0) return;
  const m = activeParty().members[coachSlot];
  const build = coachBuild(m.dex);
  if (!build) return;
  m.nature = build.nature;
  m.ability = build.ability;
  m.item = build.item;
  m.evs = Object.assign({}, build.evs);
  m.ivs = Object.assign({}, build.ivs);
  m.moves = [0, 1, 2, 3].map((i) => build.moves[i] || "");
  save();
  document.getElementById("coach-modal").hidden = true;
  renderParty();
}

/* ---------- team coach (whole-party analysis, à la pocketcraft) ---------- */
const HAZARDS = ["Stealth Rock", "Spikes", "Toxic Spikes", "Sticky Web"];
function cap(s) { return String(s).replace(/(^|[\s-])\S/g, (c) => c.toUpperCase()); }
function evSpreadStr(evs) { return STATS.filter(([k]) => evs[k]).map(([k, l]) => `${evs[k]} ${l}`).join(" / "); }
function hasStabMove(m, sp) {
  return m.moves.filter(Boolean).some((n) => { const mv = MOVE_BY_NAME[n]; return mv && mv.power > 0 && sp.types.includes(mv.type.toLowerCase()); });
}
function typesResisting(type) {
  return TYPES.filter((d) => (TYPE_CHART[type] && TYPE_CHART[type][d] != null ? TYPE_CHART[type][d] : 1) < 1);
}
// A few notable fully-evolved species that resist/are immune to `type`.
function resistersOf(type, exclude) {
  const out = [];
  for (const sp of SPECIES) {
    if (exclude.has(sp.dex)) continue;
    const c = COACH[sp.dex];
    if (!c || c.bst < 480) continue;
    let x = 1;
    for (const d of sp.types) { const v = TYPE_CHART[type] && TYPE_CHART[type][d]; if (v != null) x *= v; }
    if (x < 1) out.push({ name: sp.name, x, bst: c.bst });
  }
  out.sort((a, b) => a.x - b.x || b.bst - a.bst);
  return out.slice(0, 3).map((o) => o.name);
}
function teamAnalysis() {
  const party = activeParty();
  const members = party.members.map((m, i) => ({ m, i })).filter((x) => x.m.dex);
  if (!members.length) return { empty: true };
  const dexes = new Set(members.map((x) => x.m.dex));

  // shared type weaknesses
  const tally = {}; TYPES.forEach((t) => (tally[t] = { weak: [], covered: 0 }));
  for (const { m } of members) {
    const sp = DEX_BY_NUM[m.dex], prof = defenseProfile(sp.types);
    const wk = new Map(prof.weak), rs = new Set(prof.resist.map(([t]) => t)), im = new Set(prof.immune);
    for (const t of TYPES) {
      if (im.has(t) || rs.has(t)) tally[t].covered++;
      else if (wk.has(t)) tally[t].weak.push({ name: sp.name, x: wk.get(t) });
    }
  }
  const risks = [];
  for (const t of TYPES) {
    const tt = tally[t];
    if (tt.weak.length >= 2 && tt.weak.length > tt.covered) {
      risks.push({ type: t, weak: tt.weak, covered: tt.covered, addTypes: typesResisting(t), mons: resistersOf(t, dexes) });
    }
  }
  risks.sort((a, b) => (b.weak.length - b.covered) - (a.weak.length - a.covered));

  // role coverage
  const roleSet = new Set(); let fast = false, hazard = false;
  for (const { m } of members) {
    const b = coachBuild(m.dex);
    if (b) roleSet.add(b.role.includes("physical") ? "phys" : b.role.includes("special") ? "spec" : "wall");
    if (COACH[m.dex].base.spe >= 100) fast = true;
    if (m.moves.some((n) => HAZARDS.includes(n))) hazard = true;
  }
  const missingRoles = [];
  if (!roleSet.has("phys")) missingRoles.push("a physical attacker");
  if (!roleSet.has("spec")) missingRoles.push("a special attacker");
  if (!roleSet.has("wall")) missingRoles.push("a defensive wall / pivot");
  if (!fast) missingRoles.push("a fast Pokémon (Speed ≥ 100) for speed control");
  if (!hazard) missingRoles.push("an entry-hazard setter (Stealth Rock / Spikes)");

  // per-member upgrades + completeness
  const upgrades = []; let comp = 0;
  for (const { m, i } of members) {
    const sp = DEX_BY_NUM[m.dex], b = coachBuild(m.dex), c = COACH[m.dex];
    let cm = 0;
    if (!m.nature) upgrades.push({ mon: sp.name, slot: i, kind: "Nature", text: `No nature set — ${b.nature} (${natureBlurb(b.nature)}) fits its ${b.role}.` });
    else if (m.nature !== b.nature) { upgrades.push({ mon: sp.name, slot: i, kind: "Nature", text: `Set nature to ${b.nature} (${natureBlurb(b.nature)}) instead of ${m.nature} so stats match its ${b.role}.` }); cm += 0.5; }
    else cm += 1;
    if (!m.ability) upgrades.push({ mon: sp.name, slot: i, kind: "Ability", text: `No ability set — ${b.ability}${c.hidden && b.ability === c.hidden ? " (hidden)" : ""} is a strong pick.` });
    else { cm += 1; if (c.hidden && m.ability !== c.hidden) upgrades.push({ mon: sp.name, slot: i, kind: "Ability", text: `Consider its hidden ability ${c.hidden} for stronger competitive value.` }); }
    const ev = evSum(m);
    if (ev === 0) upgrades.push({ mon: sp.name, slot: i, kind: "EVs", text: `No EVs invested — try ${evSpreadStr(b.evs)}.` });
    else if (ev > 510) { upgrades.push({ mon: sp.name, slot: i, kind: "EVs", text: `EVs total ${ev} (over the 510 cap) — trim to a legal spread.` }); cm += 0.5; }
    else cm += 1;
    const filled = m.moves.filter(Boolean);
    const illegal = filled.filter((n) => !moveOk(movepool(m.dex), n));
    if (filled.length < 4) { upgrades.push({ mon: sp.name, slot: i, kind: "Moves", text: `Only ${filled.length}/4 moves — fill the empty slots.` }); cm += filled.length / 4; }
    else cm += 1;
    if (illegal.length) upgrades.push({ mon: sp.name, slot: i, kind: "Moves", text: `${illegal.join(", ")} can't be learned — replace.` });
    if (filled.length && !hasStabMove(m, sp)) upgrades.push({ mon: sp.name, slot: i, kind: "Moves", text: `No STAB attack — add a ${sp.types.join("/")} move for reliable damage.` });
    comp += cm / 4;
  }
  const completeness = comp / members.length;

  let score = 100;
  score -= risks.length * 9;
  score -= missingRoles.length * 5;
  score -= Math.round((1 - completeness) * 40);
  score -= (6 - members.length) * 3;
  score = Math.max(5, Math.min(100, score));
  const label = score >= 85 ? "Strong Build" : score >= 70 ? "Solid Build" : score >= 50 ? "Developing Build" : "Rough Build";
  return { empty: false, score, label, risks, missingRoles, upgrades, count: members.length };
}
function openTeamCoach() {
  const a = teamAnalysis();
  const modal = document.getElementById("coach-modal"), body = document.getElementById("coach-modal-body");
  coachSlot = -1; // no per-mon apply in team view
  if (a.empty) {
    body.innerHTML = `<h2>Team Coach</h2><p class="hint">Add some Pokémon to this party first.</p>`;
    modal.hidden = false; return;
  }
  const riskHtml = a.risks.length ? a.risks.map((r) =>
    `<div class="tc-risk"><div class="tc-risk-h">Weak to <span class="ptype t-${r.type}">${r.type}</span> — ${r.weak.length} member${r.weak.length > 1 ? "s" : ""}${r.covered ? `, ${r.covered} resist` : ""}</div>` +
    `<div class="muted">${r.weak.map((w) => `${cap(w.name)} ×${w.x}`).join(", ")}. Support with a ${r.addTypes.slice(0, 4).map(cap).join(" / ")} type${r.mons.length ? ` — try ${r.mons.map(cap).join(", ")}` : ""}.</div></div>`).join("")
    : `<p class="muted">No major shared weaknesses — solid defensive spread.</p>`;
  const roleHtml = a.missingRoles.length
    ? `<ul class="tc-list">${a.missingRoles.map((r) => `<li>Missing ${r}.</li>`).join("")}</ul>`
    : `<p class="muted">All core roles covered.</p>`;
  const upHtml = a.upgrades.length
    ? a.upgrades.map((u) => `<li><div class="tc-up"><span><b>${cap(u.mon)}</b> <span class="tc-kind">${u.kind}</span> ${u.text}</span>` +
      `<button class="tc-apply" data-slot="${u.slot}" data-kind="${u.kind}">Apply</button></div></li>`).join("")
    : `<li class="muted">Every set looks complete — great job.</li>`;
  const applyAll = a.upgrades.length ? `<button class="ctrl-btn good" id="tc-apply-all">Apply all ${a.upgrades.length} fixes</button>` : "";
  const labelClass = a.label.split(" ")[0].toLowerCase();
  body.innerHTML =
    `<div class="tc-head"><h2>Team Coach</h2><span class="tc-rating tc-${labelClass}">${a.label}</span></div>` +
    `<div class="tc-score"><div class="bar"><i style="width:${a.score}%"></i></div><span>${a.score}/100</span></div>` +
    `<p class="hint">Rating blends type weaknesses, missing roles, and how complete each Pokémon's spread &amp; moves are. ${a.count}/6 slots filled.</p>` +
    `<h3 class="cz-h">Top team risks</h3>${riskHtml}` +
    `<h3 class="cz-h">Role coverage</h3>${roleHtml}` +
    `<h3 class="cz-h">Highest-impact upgrades</h3>${applyAll}<ul class="tc-list">${upHtml}</ul>`;
  modal.hidden = false;
}
// Apply one flagged fix (or all) by writing the matching facet of the coached build.
function applyUpgradeCore(slot, kind) {
  const m = activeParty().members[slot];
  if (!m || !m.dex) return;
  const b = coachBuild(m.dex);
  if (!b) return;
  if (kind === "Nature") m.nature = b.nature;
  else if (kind === "Ability") m.ability = b.ability;
  else if (kind === "EVs") m.evs = Object.assign({}, b.evs);
  else if (kind === "Moves") m.moves = [0, 1, 2, 3].map((i) => b.moves[i] || "");
}
function applyUpgrade(slot, kind) {
  applyUpgradeCore(slot, kind);
  save(); renderParty(); openTeamCoach();
}
function applyAllUpgrades() {
  const a = teamAnalysis();
  if (a.empty) return;
  for (const u of a.upgrades) applyUpgradeCore(u.slot, u.kind);
  save(); renderParty(); openTeamCoach();
}

/* ---------- hunt tab ---------- */
const MODE_DESC = {
  chain: "Unchained chaining: each +1 is a KO of your target. Same-species KO streak raises shiny odds via threshold tiers. KO'ing a different species resets the streak.",
  breeding: "Cobbreeding: each +1 is one egg checked. Masuda (different-OT parents) multiplies the egg's shiny rate.",
  encounter: "Raw hunting: each +1 is one encounter at the flat base shiny rate.",
};
const COUNT_LABEL = { chain: "KO streak", breeding: "Eggs checked", encounter: "Encounters" };

function huntKey(mode, dex, variant) { return `${mode}:${dex}${variant ? ":" + variant : ""}`; }
function activeSession() {
  const h = state.hunt;
  if (h.activeDex == null) return null;
  return h.sessions[huntKey(h.mode, h.activeDex, h.activeVariant)] || null;
}
function ensureSession(mode, dex, variant) {
  variant = variant || null;
  const k = huntKey(mode, dex, variant);
  if (!state.hunt.sessions[k]) {
    state.hunt.sessions[k] = { mode, dex, variant, count: 0, startedAt: Date.now() };
  }
  return state.hunt.sessions[k];
}

// Cobblemon shiny base; "1 in N". Cumulative chance of >=1 success over n equal-odds rolls.
function cumulativeFlat(n, oneInN) {
  if (n <= 0 || oneInN <= 0) return 0;
  return 1 - Math.pow(1 - 1 / oneInN, n);
}

// Unchained tier for a given KO streak. Returns effective odds + next-tier info.
function chainTier(streak) {
  const base = state.config.baseShinyRate;
  const ths = [...state.config.unchainedThresholds].sort((a, b) => a[0] - b[0]);
  let bonus = 0, nextAt = null, nextBonus = null;
  for (const [at, b] of ths) {
    if (streak >= at) bonus = b;
    else { nextAt = at; nextBonus = b; break; }
  }
  const chances = bonus + 1;            // Unchained: shinyChances = points + 1
  const odds = base / chances;          // effective "1 in odds"
  let next = null;
  if (nextAt != null) next = { at: nextAt, in: nextAt - streak, odds: base / (nextBonus + 1) };
  return { odds, chances, next };
}

// Cumulative chance across a KO streak, where each KO's odds depend on the streak at that step.
function cumulativeChain(streak) {
  let pNone = 1;
  for (let k = 0; k < streak; k++) {
    const odds = chainTier(k).odds; // odds faced on the k-th encounter (streak before this KO)
    pNone *= 1 - 1 / odds;
  }
  return 1 - pNone;
}

function huntOddsLine(session) {
  if (!session) return "";
  const base = state.config.baseShinyRate;
  const n = session.count;
  if (state.hunt.mode === "chain") {
    const t = chainTier(n);
    const pct = (cumulativeChain(n) * 100).toFixed(2);
    let line = `Current odds <b>1/${Math.round(t.odds)}</b> · ${pct}% chance by now`;
    if (t.next) line += `<br><span class="muted">${t.next.in} KOs to next tier → 1/${Math.round(t.next.odds)}</span>`;
    else line += `<br><span class="muted">max tier reached</span>`;
    return line;
  }
  if (state.hunt.mode === "breeding") {
    const odds = base / state.config.masudaMultiplier;
    const pct = (cumulativeFlat(n, odds) * 100).toFixed(2);
    return `Masuda ×${state.config.masudaMultiplier} → <b>1/${Math.round(odds)}</b> per egg · ${pct}% chance by now`;
  }
  const pct = (cumulativeFlat(n, base) * 100).toFixed(2);
  return `Flat <b>1/${base}</b> · ${pct}% chance by now`;
}

function renderHunt() {
  const h = state.hunt;
  document.querySelectorAll("#hunt-mode .seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === h.mode));
  els.huntModeDesc.textContent = MODE_DESC[h.mode];
  els.huntCountLabel.textContent = COUNT_LABEL[h.mode];
  // Default the origin to match the mode (breeding → hatched), but only when the
  // user hasn't deliberately picked something else for this mode session.
  if (els.huntOrigin && !els.huntOrigin.dataset.touched) {
    els.huntOrigin.value = h.mode === "breeding" ? "hatched" : "self";
  }

  const whereBtn = document.getElementById("hunt-where");
  const s = activeSession();
  if (!s || h.activeDex == null) {
    els.huntSprite.removeAttribute("src");
    els.huntSprite.style.visibility = "hidden";
    els.huntTarget.textContent = "No target selected";
    els.huntCount.textContent = "0";
    els.huntOdds.innerHTML = "";
    if (whereBtn) whereBtn.hidden = true;
  } else {
    if (whereBtn) whereBtn.hidden = false;
    const sp = DEX_BY_NUM[h.activeDex];
    const v = h.activeVariant ? VARIANT_BY_ID[h.activeVariant] : null;
    els.huntSprite.src = v ? variantArt(v, true).src : spriteUrl(h.activeDex, true);
    els.huntSprite.style.visibility = "visible";
    els.huntSprite.alt = sp ? sp.name : "";
    els.huntTarget.textContent = v
      ? `${v.base.replace(/-/g, " ")} · ${v.name} · #${String(v.dex).padStart(4, "0")}`
      : (sp ? `${sp.name.replace(/-/g, " ")} · #${String(sp.dex).padStart(4, "0")}` : "");
    els.huntCount.textContent = String(s.count);
    els.huntOdds.innerHTML = huntOddsLine(s);
  }
  renderActiveHunts();
  renderFinds();
}

// In-progress hunts: any session with at least one encounter logged, newest first.
// (Stored in state.hunt.sessions, so it rides along in export/import for free.)
function renderActiveHunts() {
  const card = els.huntActiveCard;
  const wrap = els.huntActive;
  if (!card || !wrap) return;
  const h = state.hunt;
  const active = Object.values(h.sessions || {}).filter((s) => s && s.count > 0);
  if (!active.length) { card.hidden = true; wrap.innerHTML = ""; return; }
  card.hidden = false;
  active.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const unit = { chain: "KOs", breeding: "eggs", encounter: "enc." };
  wrap.innerHTML = active.map((s) => {
    const sp = DEX_BY_NUM[s.dex];
    const v = s.variant ? VARIANT_BY_ID[s.variant] : null;
    const name = v ? `${v.base.replace(/-/g, " ")} <span class="muted">${v.name}</span>` : (sp ? sp.name.replace(/-/g, " ") : String(s.dex));
    const img = v ? variantArt(v, true).src : spriteUrl(s.dex, true);
    const isActive = h.mode === s.mode && h.activeDex === s.dex && (h.activeVariant || null) === (s.variant || null);
    const va = s.variant ? ` data-variant="${s.variant}"` : "";
    return `<div class="find-row active-hunt${isActive ? " current" : ""}" data-mode="${s.mode}" data-dex="${s.dex}"${va} role="button" tabindex="0" title="Resume this hunt">
      <img src="${img}" alt="" />
      <span class="find-name">${name}</span>
      <span class="muted">${s.mode} · ${s.count} ${unit[s.mode] || ""}${isActive ? " · current" : ""}</span>
      <button class="ctrl-btn ah-drop" data-mode="${s.mode}" data-dex="${s.dex}"${va} title="Give up this hunt">✕</button>
    </div>`;
  }).join("");
}

function resumeHunt(mode, dex, variant) {
  variant = variant || null;
  state.hunt.mode = mode;
  state.hunt.activeDex = dex;
  state.hunt.activeVariant = variant;
  ensureSession(mode, dex, variant);
  save(); renderHunt();
}
function dropHunt(mode, dex, variant) {
  variant = variant || null;
  delete state.hunt.sessions[huntKey(mode, dex, variant)];
  if (state.hunt.mode === mode && state.hunt.activeDex === dex && (state.hunt.activeVariant || null) === variant) {
    state.hunt.activeDex = null; state.hunt.activeVariant = null;
  }
  save(); renderHunt();
}

function renderFinds() {
  const wrap = els.huntFinds;
  const finds = state.hunt.finds;
  if (!finds.length) {
    wrap.innerHTML = `<p class="hint">No shinies logged yet — go get one. ✨</p>`;
    return;
  }
  wrap.innerHTML = finds.slice().reverse().map(findRowHtml).join("");
}

/* ---------- log tab: full hunt history + on-demand showcase (#8) ---------- */
function renderLog() {
  const el = document.getElementById("log-list");
  if (!el) return;
  const finds = state.hunt.finds || [];
  const stat = document.getElementById("log-stats");
  if (stat) {
    stat.innerHTML = `<span class="stat">✨ <b>${finds.length}</b> shiny logged</span>` +
      `<span class="stat">${[...new Set(finds.map((f) => f.dex))].length} distinct species</span>`;
  }
  if (!finds.length) {
    el.innerHTML = `<p class="hint">No shinies logged yet. Log a find with ✨ Found! / 📦 Boxed! and it lands here —
      then tap it to regenerate its showcase card whenever you like.</p>`;
    return;
  }
  const q = ((els.logSearch && els.logSearch.value) || "").trim().toLowerCase().replace(/^#/, "");
  let rows = finds;
  if (q) rows = rows.filter((f) => {
    const name = (f.name || "").toLowerCase();
    const origin = ((ORIGINS[findOrigin(f)] || {}).label || "").toLowerCase();
    return name.includes(q) || (f.mode || "").toLowerCase().includes(q) || origin.includes(q) || String(f.dex) === q;
  });
  const dur = (f) => (f.foundAt || 0) - (f.startedAt || 0);
  const cmp = {
    newest: (a, b) => (b.foundAt || 0) - (a.foundAt || 0),
    oldest: (a, b) => (a.foundAt || 0) - (b.foundAt || 0),
    luckiest: (a, b) => (findLuckP(b) == null ? -1 : findLuckP(b)) - (findLuckP(a) == null ? -1 : findLuckP(a)),
    encounters: (a, b) => (b.count || 0) - (a.count || 0),
    longest: (a, b) => dur(b) - dur(a),
  }[(els.logSort && els.logSort.value) || "newest"] || ((a, b) => (b.foundAt || 0) - (a.foundAt || 0));
  rows = rows.slice().sort(cmp);
  el.innerHTML = rows.length ? rows.map(findRowHtml).join("") : `<p class="hint">No finds match that search.</p>`;
}

function setMode(mode) {
  state.hunt.mode = mode;
  if (els.huntOrigin) delete els.huntOrigin.dataset.touched; // let origin re-default per mode
  save(); renderHunt();
}
function bumpCount(delta) {
  const h = state.hunt;
  if (h.activeDex == null) return;
  const s = ensureSession(h.mode, h.activeDex, h.activeVariant);
  s.count = Math.max(0, s.count + delta);
  save(); renderHunt(); refreshDashboard();
}
function loadTarget(raw) {
  const q = String(raw || "").trim().toLowerCase().replace(/^#/, "");
  if (!q) return;
  // Exact species first (so "meowth" loads the species, not a variant).
  let sp = SPECIES.find((s) => s.name === q);
  if (!sp && /^\d+$/.test(q)) sp = DEX_BY_NUM[Number(q)];
  if (sp) { state.hunt.activeDex = sp.dex; state.hunt.activeVariant = null; ensureSession(state.hunt.mode, sp.dex); save(); renderHunt(); return; }
  // Variant query ("galarian meowth", "alolan vulpix", "rainy castform").
  const v = findVariantByQuery(raw);
  if (v) { state.hunt.activeDex = v.dex; state.hunt.activeVariant = v.id; ensureSession(state.hunt.mode, v.dex, v.id); save(); renderHunt(); return; }
  // Species prefix.
  sp = SPECIES.find((s) => s.name.startsWith(q));
  if (!sp) { alert(`No species or variant matching "${raw}".`); return; }
  state.hunt.activeDex = sp.dex;
  state.hunt.activeVariant = null;
  ensureSession(state.hunt.mode, sp.dex);
  save(); renderHunt();
}
// Resolve a free-text query to a tracked variant: the base species name AND a form
// token (regional adjective / aspect / form name) must both appear.
function findVariantByQuery(raw) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const nq = norm(raw);
  if (!nq) return null;
  let best = null, bestScore = 0;
  for (const v of allVariantObjs()) {
    const baseN = norm(v.base);
    if (!baseN || !nq.includes(baseN)) continue;             // base species must appear
    const forms = [norm(v.name), ...(v.aspects || []).map(norm)].filter(Boolean);
    const hit = forms.filter((f) => nq.includes(f));
    if (!hit.length) continue;                               // a form token must appear
    const score = baseN.length + hit.reduce((a, f) => a + f.length, 0);
    if (score > bestScore) { bestScore = score; best = v; }
  }
  return best;
}
// Start (or resume) a hunt for a specific variant — e.g. Galarian Meowth.
function startHuntFromVariant(variantId) {
  const v = VARIANT_BY_ID[variantId];
  if (!v) return;
  state.hunt.activeDex = v.dex;
  state.hunt.activeVariant = v.id;
  ensureSession(state.hunt.mode, v.dex, v.id);
  save(); renderHunt(); showTab("hunt");
}
// Begin hunting a species straight away (used by the "What to hunt next" card):
// set it as the active target, optionally switch mode, and jump to the Hunt tab.
function startHuntFor(dex, mode) {
  const sp = DEX_BY_NUM[dex];
  if (!sp) return;
  if (mode) state.hunt.mode = mode;
  state.hunt.activeDex = dex;
  state.hunt.activeVariant = null;
  ensureSession(state.hunt.mode, dex);
  if (els.huntInput) els.huntInput.value = sp.name;
  if (els.huntOrigin) delete els.huntOrigin.dataset.touched; // re-default origin for the new mode
  save(); renderHunt();
  showTab("hunt");
}
// The pool 🎲 Surprise me draws from, per the chosen scope.
//  smart    – wishlist (un-caught) → not-yet-shiny → anything  (the default)
//  unshiny  – anything you haven't shiny-caught yet
//  all      – literally any species
// Pool of TARGETS — species ({dex,name}) and variants ({dex,name,variant:id}).
function variantShiny(id) { return state.variants[id] === "shiny"; }
function randomPool(scope) {
  const hasShiny = (st) => st === "shiny" || st === "boxed";
  const spT = (sp) => ({ dex: sp.dex, name: sp.name });
  const vT = (v) => ({ dex: v.dex, name: `${v.base} (${v.name})`, variant: v.id });
  const vars = allVariantObjs();
  switch (scope) {
    case "unshiny":
      return SPECIES.filter((sp) => !hasShiny(dexState(sp.dex))).map(spT)
        .concat(vars.filter((v) => !variantShiny(v.id)).map(vT));
    case "all":
      return SPECIES.map(spT).concat(vars.map(vT));
    case "smart":
    default: {
      const notDone = (sp) => !hasShiny(dexState(sp.dex));
      const wished = state.wishlist.map((d) => DEX_BY_NUM[d]).filter((sp) => sp && notDone(sp)).map(spT)
        .concat((state.variantWishlist || []).map((id) => VARIANT_BY_ID[id]).filter((v) => v && !variantShiny(v.id)).map(vT));
      if (wished.length) return wished;
      const fresh = SPECIES.filter(notDone).map(spT).concat(vars.filter((v) => !variantShiny(v.id)).map(vT));
      return fresh.length ? fresh : SPECIES.map(spT);
    }
  }
}
// Bored? Roll a random target (species or variant) from the chosen scope.
function randomHuntTarget() {
  const pool = randomPool(state.config.randomScope || "smart");
  if (!pool.length) { alert("Nothing matches that random filter yet — try a different one."); return; }
  const t = pool[Math.floor(Math.random() * pool.length)];
  state.hunt.activeDex = t.dex;
  state.hunt.activeVariant = t.variant || null;
  ensureSession(state.hunt.mode, t.dex, t.variant || null);
  els.huntInput.value = DEX_BY_NUM[t.dex] ? DEX_BY_NUM[t.dex].name : "";
  save(); renderHunt();
  const card = els.huntInput.closest(".card");
  if (card) { card.classList.remove("flash"); void card.offsetWidth; card.classList.add("flash"); }
}
// Log the active hunt's shiny. `boxed` = caught AND already deposited, so the
// dex jumps straight to Boxed (closing the find → box loop in one tap); otherwise
// it's promoted to at least Shiny without downgrading an already-Boxed entry.
function foundShiny(boxed) {
  const h = state.hunt;
  if (h.activeDex == null) { alert("Load a target first."); return; }
  const sp = DEX_BY_NUM[h.activeDex];
  const v = h.activeVariant ? VARIANT_BY_ID[h.activeVariant] : null;
  const s = ensureSession(h.mode, h.activeDex, h.activeVariant);
  // Stamp the luck (vs the odds in effect right now) so it stays accurate even
  // if the pack's odds settings change later.
  const luck = computeLuck(h.mode, s.count).p;
  const now = Date.now();
  const origin = (els.huntOrigin && els.huntOrigin.value) || (h.mode === "breeding" ? "hatched" : "self");
  const find = {
    id: "f" + now.toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    dex: h.activeDex, name: sp ? sp.name : String(h.activeDex), mode: h.mode, count: s.count,
    startedAt: s.startedAt || now, foundAt: now, luck, origin,
    variant: v ? v.id : null, vname: v ? v.name : null,
  };
  state.hunt.finds.push(find);
  if (v) {
    // A hunted variant updates the Variants page (caught → shiny on a found shiny).
    state.variants[v.id] = "shiny";
  } else if (boxed) state.dex[String(h.activeDex)] = "boxed";
  else if (dexState(h.activeDex) !== "boxed") state.dex[String(h.activeDex)] = "shiny";
  // Reset this session's count AND clock for a fresh hunt.
  s.count = 0;
  s.startedAt = now;
  save(); renderHunt(); renderDex(); renderBoxes(); refreshDashboard(); refreshStats(); renderLog(); renderVariants();
  // Celebrate immediately: pop the shareable showcase for the catch you just logged,
  // so you never have to dig through Recent finds to generate it.
  openShowcase(find.id);
}
// Log an off-hunt / "random encounter" shiny — one you bumped into while NOT
// hunting it. Uses the species typed in the target box, doesn't touch any active
// hunt, and is flagged `random` so it stays out of the encounter & luck averages.
function logRandomCatch(boxed) {
  const raw = (els.huntInput && els.huntInput.value) || "";
  const q = String(raw).trim().toLowerCase().replace(/^#/, "");
  if (!q) { alert("Type which Pokémon you caught in the Target box, then log it."); return; }
  const sp = SPECIES.find((s) => s.name === q) || (/^\d+$/.test(q) ? DEX_BY_NUM[Number(q)] : null) || SPECIES.find((s) => s.name.startsWith(q));
  if (!sp) { alert(`No species matching "${raw}".`); return; }
  const now = Date.now();
  const origin = (els.huntOrigin && els.huntOrigin.value) || "self";
  const find = {
    id: "f" + now.toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    dex: sp.dex, name: sp.name, mode: "random", count: 0, random: true,
    startedAt: null, foundAt: now, luck: null, origin,
  };
  state.hunt.finds.push(find);
  if (boxed) state.dex[String(sp.dex)] = "boxed";
  else if (dexState(sp.dex) !== "boxed") state.dex[String(sp.dex)] = "shiny";
  save(); renderHunt(); renderDex(); renderBoxes(); refreshDashboard(); refreshStats(); renderLog();
  openShowcase(find.id);
}

// Drop a mod-synced shiny into the Recent-finds log so server catches show up
// alongside hand-logged ones. Called when the mod sync first promotes a species to
// shiny. Per the off-hunt rule: it's a random / off-hunt find UNLESS there's an
// in-progress hunt for that species (a session with encounters logged), in which
// case we log it against that hunt and carry its encounter count. Returns true if a
// find was added. Idempotent: skips species that already have a (non-variant) find.
function logFindFromMod(dex) {
  const sp = DEX_BY_NUM[dex];
  if (!sp) return false;
  if (state.hunt.finds.some((f) => f.dex === dex && !f.variant)) return false;
  const now = Date.now();
  // Most-progressed base-species (non-variant) hunt session for this dex, if any.
  let best = null;
  for (const s of Object.values(state.hunt.sessions || {})) {
    if (s && s.dex === dex && !s.variant && (s.count || 0) > (best ? best.count : 0)) best = s;
  }
  const id = "f" + now.toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  if (best) {
    const mode = best.mode || "encounter";
    state.hunt.finds.push({
      id, dex, name: sp.name, mode, count: best.count,
      startedAt: best.startedAt || now, foundAt: now,
      luck: computeLuck(mode, best.count).p, origin: "self",
      variant: null, vname: null, fromMod: true,
    });
    best.count = 0; best.startedAt = now; // consume the hunt, just like a manual Found!
  } else {
    state.hunt.finds.push({
      id, dex, name: sp.name, mode: "random", count: 0, random: true,
      startedAt: null, foundAt: now, luck: null, origin: "self", fromMod: true,
    });
  }
  return true;
}

/* ---------- start a hunt from a Dex card ---------- */
let huntStartDex = null;
function openHuntStart(dex) {
  const sp = DEX_BY_NUM[dex];
  if (!sp) return;
  huntStartDex = dex;
  document.getElementById("hunt-start-body").innerHTML =
    `<h2>Start a hunt</h2>` +
    `<figure class="hs-target">` +
      `<img src="${spriteUrl(dex, true)}" alt="${sp.name}" />` +
      `<figcaption>${sp.name.replace(/-/g, " ")} · #${String(dex).padStart(4, "0")}</figcaption>` +
    `</figure>` +
    `<p class="hint" style="margin:0 0 10px">How are you hunting this one?</p>` +
    `<div class="controls hs-modes">` +
      `<button class="ctrl-btn good" data-hsmode="encounter">⚔ Encounter</button>` +
      `<button class="ctrl-btn good" data-hsmode="breeding">🥚 Breeding</button>` +
    `</div>`;
  document.getElementById("hunt-start-modal").hidden = false;
}
function closeHuntStart() {
  document.getElementById("hunt-start-modal").hidden = true;
  huntStartDex = null;
}
function startHuntFromDex(mode) {
  if (huntStartDex == null) return;
  state.hunt.mode = mode;
  state.hunt.activeDex = huntStartDex;
  state.hunt.activeVariant = null;
  ensureSession(mode, huntStartDex);
  closeHuntStart();
  save(); renderHunt();
  showTab("hunt");
}

/* ---------- Per-Pokémon detail page (unified) ----------
 * One modal that gathers everything the app already knows about a species: dex
 * state, hunt history, spawn locations, best snack, forms/variants, legendary
 * data, and the battle build. Opened by the ⓘ button on Dex cards and Box slots.
 * Reuses the existing renderers so there's a single source of truth per section. */
let detailDex = null;
const DEX_STATE_LABEL = { seen: "Seen", caught: "Caught", shiny: "Shiny", boxed: "Boxed" };

function mdTypeChips(sp) {
  return (sp.types || []).map((t) => `<span class="md-type t-${String(t).toLowerCase()}">${t}</span>`).join("");
}

function detailHeaderHtml(dex) {
  const sp = DEX_BY_NUM[dex];
  const st = dexState(dex);
  const shiny = st === "shiny" || st === "boxed";
  const c = COACH[dex];
  const wished = state.wishlist.includes(dex);
  const fb = spriteUrl(dex, false);
  return `<div class="md-head">
    <img class="md-art" src="${spriteUrl(dex, shiny)}" alt="${sp.name}" onerror="this.onerror=null;this.src='${fb}'"/>
    <div class="md-headinfo">
      <h2>${sp.name.replace(/-/g, " ")} <span class="muted">#${String(dex).padStart(4, "0")}</span></h2>
      <div class="md-meta">Gen ${sp.gen}${c ? ` · BST ${c.bst}` : ""}${isLegendary(dex) ? " · ✨ Legendary" : ""}</div>
      <div class="md-types">${mdTypeChips(sp)}</div>
      <div class="md-actions">
        <button class="ctrl-btn good md-hunt" data-dex="${dex}">🎯 Hunt</button>
        <button class="ctrl-btn md-star${wished ? " on" : ""}" data-dex="${dex}">${wished ? "★ Wishlisted" : "☆ Wishlist"}</button>
        <button class="ctrl-btn md-where" data-dex="${dex}">🗺 Spawns</button>
      </div>
    </div>
  </div>`;
}

function detailStateHtml(dex) {
  const cur = dexState(dex);
  const btns = DEX_STATES.map((s) => s === "none"
    ? `<button class="md-st-btn${cur === "none" ? " on" : ""}" data-dex="${dex}" data-st="none">○ Unseen</button>`
    : `<button class="md-st-btn s-${s}${cur === s ? " on" : ""}" data-dex="${dex}" data-st="${s}">${STATE_BADGE[s] || ""} ${DEX_STATE_LABEL[s]}</button>`
  ).join("");
  const box = Math.floor((dex - 1) / BOX_SIZE) + 1, slot = ((dex - 1) % BOX_SIZE) + 1;
  return `<section class="md-sec"><h3>Dex state</h3>
    <div class="md-states">${btns}</div>
    <div class="md-box">📦 Box ${box}, slot ${slot} · <button class="link-btn md-gobox" data-dex="${dex}">go to box →</button></div>
  </section>`;
}

function detailHuntsHtml(dex) {
  const finds = (state.hunt.finds || []).filter((f) => f.dex === dex).sort((a, b) => b.foundAt - a.foundAt);
  const sessions = Object.values(state.hunt.sessions || {}).filter((s) => s.dex === dex && s.count > 0);
  if (!finds.length && !sessions.length) {
    return `<section class="md-sec"><h3>Hunt history</h3><p class="hint">No hunts or finds logged yet. Start one with 🎯 above.</p></section>`;
  }
  const active = sessions.map((s) => {
    const v = s.variant ? VARIANT_BY_ID[s.variant] : null;
    return `<div class="md-active">🔎 In progress · ${s.mode}${v ? " · " + v.name : ""} · <b>${s.count}</b> ${s.mode === "breeding" ? "eggs" : s.mode === "chain" ? "KOs" : "encounters"}</div>`;
  }).join("");
  const rows = finds.map(findRowHtml).join("");
  return `<section class="md-sec"><h3>Hunt history <span class="muted">· ${finds.length} find${finds.length !== 1 ? "s" : ""}</span></h3>
    ${active}${rows || `<p class="hint">No shiny logged for this one yet.</p>`}</section>`;
}

function detailSpawnsHtml(dex) {
  return `<section class="md-sec"><h3>Where it spawns</h3>${renderSpawnByMon(dex)}</section>`;
}

function detailSnackHtml(dex) {
  if (isSnackBlacklisted(dex)) {
    return `<section class="md-sec"><h3>Best Poké Snack</h3><p class="hint">Legendary / special — a Poké Snack can't lure this one.</p></section>`;
  }
  const best = bestSnackFor(dex, 0);
  if (!best) {
    return `<section class="md-sec"><h3>Best Poké Snack</h3><p class="hint">No natural snack-attractable spawn in base Cobblemon.</p></section>`;
  }
  const baseRate = state.config.baseShinyRate;
  const eff = baseRate / best.shiny;
  const snacks = Math.max(1, Math.ceil((eff / best.p) / SNACK_BITES));
  const lureNote = SNACK_BLACKLIST.has(dex)
    ? `<p class="hint" style="margin:6px 0 0">${SNACK_LURE_NOTE}</p>` : "";
  return `<section class="md-sec"><h3>Best Poké Snack</h3>
    <div class="md-snack">
      <div class="plan-row"><span>Biome</span><b style="text-transform:capitalize">${isIngameBiome(best.biome) ? biomeLabel(best.biome) : best.biome}</b></div>
      <div class="plan-row"><span>Snack</span><b>${fmtCombo(best.combo)}</b></div>
      <div class="plan-row"><span>Spawn rate</span><b>${(best.p * 100).toFixed(1)}%</b></div>
      <div class="plan-row"><span>Shiny odds</span><b>1/${Math.round(eff).toLocaleString()}</b> (✨×${best.shiny})</div>
      <div class="plan-row"><span>Snacks to shiny</span><b>~${snacks.toLocaleString()}</b> <span class="muted">expected</span></div>
    </div>
    <button class="link-btn md-snackplan" data-dex="${dex}">Open in the Poké Snack planner →</button>${lureNote}
  </section>`;
}

function detailFormsHtml(dex) {
  const forms = FORMS ? [...FORMS.mega, ...FORMS.primal, ...FORMS.gmax].filter((f) => f.dex === dex) : [];
  const vars = allVariantObjs().filter((v) => v.dex === dex);
  if (!forms.length && !vars.length) return "";
  let html = `<section class="md-sec"><h3>Forms & variants</h3>`;
  if (vars.length) html += `<div class="grid md-vargrid" id="md-vargrid"></div>`;
  if (forms.length) {
    html += `<div class="md-forms">` + forms.map((f) =>
      `<span class="md-form${state.forms[f.id] ? " on" : ""}">${state.forms[f.id] ? "✓ " : ""}${f.label}</span>`).join("") + `</div>`;
  }
  return html + `</section>`;
}

function detailLegendHtml(dex) {
  const e = LEGEND_BY_DEX[dex];
  if (!e) return "";
  const tier = (LEGENDS && LEGENDS.tiers.find((t) => t.key === e.tier)) || {};
  const struct = e.struct || [];
  return `<section class="md-sec"><h3>Legendary</h3>
    <div class="md-leg">
      <div>${tier.icon || "✨"} ${tier.label || e.tier}${e.sys ? ` · <span class="muted">${e.sys}</span>` : ""}</div>
      ${struct.length ? `<div class="md-leg-struct">${struct.map((s) => `<span class="struct-chip leg-locate" data-locate="${s}" title="Copy /locate command">🏛 ${s}</span>`).join(" ")}</div>` : ""}
      ${e.note ? `<p class="hint" style="margin:6px 0 0">${e.note}</p>` : ""}
    </div></section>`;
}

function detailCoachHtml(dex) {
  const b = coachBuild(dex);
  if (!b) return "";
  return `<section class="md-sec"><h3>Battle build <span class="muted">· coach pick</span></h3>
    <div class="md-coach">
      <div class="md-coach-role"><b>${b.role}</b> · ${b.nature} nature · ${b.ability}</div>
      <div class="cz-stats">${statBars(b.base)}</div>
      <div class="md-moves">${b.moves.map((m) => `<span class="md-move">${m}</span>`).join("")}</div>
      <p class="hint" style="margin:8px 0 0">${b.why}</p>
    </div></section>`;
}

// Breeding (egg groups → Masuda compatibility) + EV yield, straight from species data.
function detailBreedingHtml(dex) {
  const sp = DEX_BY_NUM[dex];
  const eg = (sp.eggGroups || []).join(", ");
  const ev = (sp.ev || []).join(", ");
  if (!eg && !ev) return "";
  return `<section class="md-sec"><h3>Breeding & training</h3>
    <div class="md-kv">
      ${eg ? `<div><span class="muted">Egg groups</span> ${eg}</div>` : ""}
      ${ev ? `<div><span class="muted">EV yield</span> ${ev}</div>` : ""}
    </div></section>`;
}

function monDetailHtml(dex) {
  return detailHeaderHtml(dex)
    + detailStateHtml(dex)
    + detailHuntsHtml(dex)
    + detailSpawnsHtml(dex)
    + detailSnackHtml(dex)
    + detailFormsHtml(dex)
    + detailLegendHtml(dex)
    + detailCoachHtml(dex)
    + detailBreedingHtml(dex);
}

function renderMonDetail() {
  if (detailDex == null) return;
  const body = document.getElementById("mon-detail-body");
  if (!body) return;
  body.innerHTML = monDetailHtml(detailDex);
  const vg = body.querySelector("#md-vargrid");
  if (vg) allVariantObjs().filter((v) => v.dex === detailDex).forEach((v) => vg.appendChild(variantCard(v)));
  body.scrollTop = 0;
}

function openMonDetail(dex) {
  if (!DEX_BY_NUM[dex]) return;
  detailDex = dex;
  renderMonDetail();
  document.getElementById("mon-detail-modal").hidden = false;
}
function closeMonDetail() {
  const m = document.getElementById("mon-detail-modal");
  if (m) m.hidden = true;
  detailDex = null;
}

/* ---------- luck (#6) ---------- */
// Effective flat "1 in N" odds for the non-chain modes.
function effectiveFlatOdds(mode) {
  const base = state.config.baseShinyRate;
  return mode === "breeding" ? base / state.config.masudaMultiplier : base;
}
// p = fraction of equivalent hunts that would STILL be searching at this count,
// i.e. how lucky this find was (higher = luckier; .5 ≈ the median hunt).
// expected = mean count for flat modes (null for chains, whose odds vary by streak).
function computeLuck(mode, count) {
  count = Math.max(0, Number(count) || 0);
  if (mode === "chain") return { p: 1 - cumulativeChain(count), expected: null };
  const odds = effectiveFlatOdds(mode);
  return { p: Math.pow(1 - 1 / odds, count), expected: Math.round(odds) };
}
// An off-hunt / "random encounter" find: caught while not hunting it, so it has
// no meaningful encounter count or luck and is excluded from the averages.
function isRandomFind(f) { return !!(f && f.random); }
function trackedFinds() { return (state.hunt.finds || []).filter((f) => !isRandomFind(f)); }
function findLuckP(f) {
  if (isRandomFind(f)) return null; // untracked — no luck to compute
  return (typeof f.luck === "number") ? f.luck : computeLuck(f.mode, f.count).p;
}
function luckBadge(p) {
  if (p >= 0.95) return { cls: "luck-amazing", txt: "🍀 Insane luck" };
  if (p >= 0.80) return { cls: "luck-great", txt: "🍀 Very lucky" };
  if (p >= 0.60) return { cls: "luck-good", txt: "Lucky" };
  if (p >= 0.40) return { cls: "luck-avg", txt: "Average" };
  if (p >= 0.20) return { cls: "luck-bad", txt: "Unlucky" };
  if (p >= 0.05) return { cls: "luck-rough", txt: "Rough" };
  return { cls: "luck-brutal", txt: "💀 Brutal" };
}
// Obtainment origin (#3) — how a shiny was acquired.
const ORIGINS = {
  self: { icon: "⚔", label: "Caught" },
  hatched: { icon: "🥚", label: "Hatched" },
  traded: { icon: "🤝", label: "Traded" },
  raid: { icon: "🛡", label: "Raid" },
};
function findOrigin(f) { return ORIGINS[f.origin] ? f.origin : (f.mode === "breeding" ? "hatched" : "self"); }
function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// Human "2h 14m" / "45m" / "30s" from a duration in ms (null if unknown/zero).
// (Distinct from the Farm tab's fmtDuration(hours) — keep the names separate.)
function fmtElapsed(ms) {
  if (!ms || ms < 1000) return null;
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}
// Effective "1 in N" odds and cumulative % at the moment this find was logged.
function findOdds(f) {
  const count = Number(f.count) || 0;
  if (f.mode === "chain") return { oneIn: Math.round(chainTier(count).odds), pct: cumulativeChain(count) * 100 };
  const odds = f.mode === "breeding" ? state.config.baseShinyRate / state.config.masudaMultiplier : state.config.baseShinyRate;
  return { oneIn: Math.round(odds), pct: cumulativeFlat(count, odds) * 100 };
}
const COUNT_UNIT = { breeding: "eggs", chain: "KOs", encounter: "enc." };
// Shared "recent finds" row (Home + Hunt + Stats) — luck + origin chips, tap to showcase.
function findRowHtml(f) {
  const date = fmtDate(f.foundAt);
  const o = ORIGINS[findOrigin(f)];
  const v = f.variant ? VARIANT_BY_ID[f.variant] : null;
  const vtag = v ? ` <span class="muted">${v.name}</span>` : (f.vname ? ` <span class="muted">${f.vname}</span>` : "");
  const head = `<div class="find-row find-show" data-find="${f.id}" role="button" tabindex="0" title="Open shareable showcase card">` +
    `<img src="${v ? variantArt(v, true).src : spriteUrl(f.dex, true)}" alt="" />` +
    `<span class="find-name">${(f.name || "").replace(/-/g, " ")}${vtag}</span>` +
    `<span class="origin-chip" title="How you got it">${o.icon} ${o.label}</span>`;
  const del = `<button class="find-del" data-find="${f.id}" title="Delete this log (the Dex shiny stays)" aria-label="Delete this log">✕</button>`;
  if (isRandomFind(f)) {
    return head +
      `<span class="luck-chip luck-random" title="Off-hunt catch — kept out of the encounter &amp; luck averages">🎲 Random</span>` +
      `<span class="muted">off-hunt · ${date}</span>${del}</div>`;
  }
  const unit = f.mode === "breeding" ? " eggs" : f.mode === "chain" ? " KOs" : "";
  const p = findLuckP(f);
  const b = luckBadge(p);
  return head +
    `<span class="luck-chip ${b.cls}" title="Luckier than ${Math.round(p * 100)}% of equivalent hunts">${b.txt}</span>` +
    `<span class="muted">${f.mode} · ${f.count}${unit} · ${date}</span>${del}</div>`;
}
// Remove a mis-logged find (e.g. wrong mode/origin). Keeps the Dex shiny — only the
// log record is deleted, so the user can re-log it correctly.
function deleteFind(id) {
  const finds = state.hunt.finds || [];
  const f = finds.find((x) => x.id === id);
  if (!f) return;
  const nm = (f.name || "").replace(/-/g, " ");
  const what = isRandomFind(f) ? "off-hunt catch" : `${f.mode} · ${f.count}`;
  if (!confirm(`Delete this log?\n\n${nm} — ${what}\n\nThis removes the log record only; the Dex shiny stays. You can re-log it correctly afterward.`)) return;
  state.hunt.finds = finds.filter((x) => x.id !== id);
  save(); renderHunt(); refreshDashboard(); refreshStats(); renderLog();
}

/* ---------- shiny showcase card (#3/#4) ---------- */
let showcaseFind = null;
function titleName(n) { return String(n || "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }
function luckColor(cls) {
  if (cls === "luck-amazing" || cls === "luck-great") return "#f6c544";
  if (cls === "luck-good") return "#4fd1c5";
  if (cls === "luck-avg") return "#93a4b8";
  return "#ef4444";
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function showcaseText(f) {
  const o = ORIGINS[findOrigin(f)];
  const head = `✨ Shiny ${titleName(f.name)} ✨  #${String(f.dex).padStart(4, "0")}`;
  if (isRandomFind(f)) {
    return [head, `🎲 Random encounter (off-hunt)`, `${o.icon} ${o.label} · ${fmtDate(f.foundAt)}`, `— tracked in ShinyDex HQ`].join("\n");
  }
  const od = findOdds(f);
  const dur = fmtElapsed((f.foundAt || 0) - (f.startedAt || 0));
  return [
    head,
    `${MODE_NAME[f.mode] || f.mode} · ${f.count} ${COUNT_UNIT[f.mode] || ""}`.trim(),
    `Odds 1/${od.oneIn} · ${od.pct.toFixed(1)}% by then · ${luckBadge(findLuckP(f)).txt}`,
    `${o.icon} ${o.label}${dur ? ` · ${dur}` : ""} · ${fmtDate(f.foundAt)}`,
    `— tracked in ShinyDex HQ`,
  ].join("\n");
}
// Draw the showcase card. `img` is the (optionally loaded) shiny sprite.
function paintShowcase(f, img) {
  const cv = els.showcaseCanvas, ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#1b2c40"); bg.addColorStop(1, "#0b1322");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#f6c544"; ctx.lineWidth = 4; ctx.strokeRect(7, 7, W - 14, H - 14);

  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = "#f6c544"; ctx.font = "bold 32px system-ui, -apple-system, sans-serif";
  ctx.fillText(`✨ ${titleName(f.name)} ✨`, W / 2, 50);
  ctx.fillStyle = "#93a4b8"; ctx.font = "16px system-ui, sans-serif";
  ctx.fillText(`#${String(f.dex).padStart(4, "0")}`, W / 2, 80);

  const sx = 56, sy = 104, ss = 184;
  if (img) { ctx.imageSmoothingEnabled = false; ctx.drawImage(img, sx, sy, ss, ss); }

  const o = ORIGINS[findOrigin(f)];
  const random = isRandomFind(f);
  // Pill centred under the sprite: luck for a hunt, a neutral "Random" for off-hunt.
  const lb = random ? { cls: "luck-random", txt: "🎲 Random encounter" } : luckBadge(findLuckP(f));
  ctx.font = "bold 16px system-ui, sans-serif";
  const pw = ctx.measureText(lb.txt).width + 28, ph = 30, px = sx + ss / 2 - pw / 2, py = sy + ss + 4;
  roundRect(ctx, px, py, pw, ph, 15); ctx.fillStyle = random ? "#93a4b8" : luckColor(lb.cls); ctx.fill();
  ctx.fillStyle = "#0b1322"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(lb.txt, sx + ss / 2, py + ph / 2 + 1);

  // Info column — an off-hunt catch carries no count/odds/time, just how & when.
  const rows = random
    ? [["Method", "🎲 Random encounter"], ["Obtained", `${o.icon} ${o.label}`], ["Date", fmtDate(f.foundAt)]]
    : (() => {
      const od = findOdds(f), dur = fmtElapsed((f.foundAt || 0) - (f.startedAt || 0));
      const r = [
        ["Method", MODE_NAME[f.mode] || f.mode],
        ["Count", `${f.count} ${COUNT_UNIT[f.mode] || ""}`.trim()],
        ["Odds at find", `1 / ${od.oneIn}  ·  ${od.pct.toFixed(1)}%`],
        ["Obtained", `${o.icon} ${o.label}`],
      ];
      if (dur) r.push(["Hunt time", dur]);
      r.push(["Date", fmtDate(f.foundAt)]);
      return r;
    })();
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  const ix = 280, iy = 126, lh = 40;
  rows.forEach((r, i) => {
    const y = iy + i * lh;
    ctx.fillStyle = "#93a4b8"; ctx.font = "14px system-ui, sans-serif";
    ctx.fillText(r[0].toUpperCase(), ix, y);
    ctx.fillStyle = "#e7eef7"; ctx.font = "bold 20px system-ui, sans-serif";
    ctx.fillText(r[1], ix, y + 23);
  });

  ctx.fillStyle = "#4fd1c5"; ctx.textAlign = "right"; ctx.font = "15px system-ui, sans-serif";
  ctx.fillText("ShinyDex HQ · Cobbleverse", W - 22, H - 22);
}
function renderShowcase() {
  const f = showcaseFind; if (!f) return;
  paintShowcase(f, null); // immediate paint; sprite drops in on load
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => { if (showcaseFind === f) paintShowcase(f, img); };
  img.src = spriteUrl(f.dex, true);
}
function openShowcase(id) {
  const f = state.hunt.finds.find((x) => x.id === id);
  if (!f) return;
  showcaseFind = f;
  els.showcaseOrigin.value = findOrigin(f);
  els.showcaseShare.hidden = !(navigator.canShare && navigator.share);
  els.showcaseModal.hidden = false;
  renderShowcase();
}
function showcaseFilename(f) { return `shiny-${titleName(f.name).replace(/\s+/g, "-").toLowerCase()}.png`; }
function showcaseBlob() { return new Promise((res) => els.showcaseCanvas.toBlob(res, "image/png")); }
async function showcaseDownload() {
  try {
    const blob = await showcaseBlob();
    if (!blob) throw new Error("no blob");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = showcaseFilename(showcaseFind); a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { alert("Couldn't export the image (the sprite host may block canvas export). Use Copy text instead."); }
}
async function showcaseShare() {
  try {
    const blob = await showcaseBlob();
    const file = blob && new File([blob], showcaseFilename(showcaseFind), { type: "image/png" });
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text: showcaseText(showcaseFind) });
    } else {
      await navigator.share({ text: showcaseText(showcaseFind) });
    }
  } catch (e) { /* user cancelled or share unavailable */ }
}
function showcaseCopy() {
  const txt = showcaseText(showcaseFind);
  const done = () => { const o = els.showcaseCopy.textContent; els.showcaseCopy.textContent = "✓ Copied"; setTimeout(() => (els.showcaseCopy.textContent = o), 1000); };
  if (navigator.clipboard) navigator.clipboard.writeText(txt).then(done, done); else done();
}

/* ---------- wishlist (#8) ---------- */
function toggleWishlist(dex) {
  const i = state.wishlist.indexOf(dex);
  if (i >= 0) state.wishlist.splice(i, 1); else state.wishlist.push(dex);
  save();
}
function toggleVariantWishlist(id) {
  if (!Array.isArray(state.variantWishlist)) state.variantWishlist = [];
  const i = state.variantWishlist.indexOf(id);
  if (i >= 0) state.variantWishlist.splice(i, 1); else state.variantWishlist.push(id);
  save();
}

/* ---------- home / dashboard ---------- */
const MODE_NAME = { chain: "KO-Chain", breeding: "Breeding", encounter: "Encounter" };

// Only rebuild the dashboard when it's the visible panel — its live controls
// (the +1 counter, Found/Boxed) can only be used while Home is on screen, so
// the handful of mutators that call this never waste work on a hidden panel.
function refreshDashboard() {
  const home = document.getElementById("panel-home");
  if (home && home.classList.contains("active")) renderDashboard();
}
function renderDashboard() {
  renderDashBackup();
  renderDashHunt();
  renderDashProgress();
  renderDashGoals();
  renderDashNext();
  renderDashWishlist();
  renderDashGaps();
  renderDashFinds();
}

function renderDashWishlist() {
  const el = document.getElementById("dash-wishlist");
  if (!el) return;
  const list = state.wishlist.map((d) => DEX_BY_NUM[d]).filter(Boolean);
  const vlist = (state.variantWishlist || []).map((id) => VARIANT_BY_ID[id]).filter(Boolean);
  if (!list.length && !vlist.length) {
    el.innerHTML = `<h2>★ Wishlist</h2><p class="hint">Star Pokémon on the Dex (tap ☆) or variants on the Variants tab to pin your hunt goals here. 🎲 Surprise me favours them.</p>`;
    return;
  }
  const spCards = list.map((sp) => {
    const st = dexState(sp.dex);
    const done = st === "shiny" || st === "boxed";
    const nm = sp.name.replace(/-/g, " ");
    return `<div class="dash-gap${done ? " wl-done" : ""}" data-dex="${sp.dex}" role="button" tabindex="0" title="Jump to ${nm} in Boxes">` +
      `<button class="dash-gap-hunt" data-dex="${sp.dex}" title="Start a hunt for ${nm}">🎯</button>` +
      `<button class="dash-wl-star" data-dex="${sp.dex}" title="Remove ${nm} from wishlist">★</button>` +
      `<img loading="lazy" src="${spriteUrl(sp.dex, true)}" alt="${sp.name}" />` +
      `<span class="dash-gap-no">#${String(sp.dex).padStart(4, "0")}</span>` +
      `<span class="dash-gap-nm">${nm}</span>` +
      `${done ? `<span class="wl-badge">${st === "boxed" ? "📦" : "✨"}</span>` : ""}` +
    `</div>`;
  });
  const vCards = vlist.map((v) => {
    const done = variantShiny(v.id);
    const nm = `${v.base.replace(/-/g, " ")} ${v.name}`;
    return `<div class="dash-gap${done ? " wl-done" : ""}" data-variant="${v.id}" role="button" tabindex="0" title="Start a hunt for ${nm}">` +
      `<button class="dash-gap-hunt" data-variant="${v.id}" title="Start a hunt for ${nm}">🎯</button>` +
      `<button class="dash-wl-star" data-variant="${v.id}" title="Remove ${nm} from wishlist">★</button>` +
      `<img loading="lazy" src="${variantArt(v, done).src}" alt="${nm}" />` +
      `<span class="dash-gap-no">#${String(v.dex).padStart(4, "0")}</span>` +
      `<span class="dash-gap-nm">${v.base.replace(/-/g, " ")} <span class="muted">${v.name}</span></span>` +
      `${done ? `<span class="wl-badge">✨</span>` : ""}` +
    `</div>`;
  });
  el.innerHTML =
    `<h2>★ Wishlist <span class="muted">— ${list.length + vlist.length}</span></h2>` +
    `<div class="dash-gaps-row">` + spCards.concat(vCards).join("") + `</div>`;
}

function renderDashHunt() {
  const el = document.getElementById("dash-hunt");
  if (!el) return;
  const h = state.hunt;
  const s = activeSession();
  if (!s || h.activeDex == null) {
    el.innerHTML =
      `<h2>Active hunt</h2>` +
      `<p class="hint">No hunt in progress. Pick a target from the Dex (tap 🎯) — or roll one:</p>` +
      `<div class="controls">` +
        `<button class="ctrl-btn good" id="dash-surprise">🎲 Surprise me</button>` +
        `<button class="ctrl-btn" data-gotab="hunt">Open Hunt →</button>` +
      `</div>`;
    return;
  }
  const sp = DEX_BY_NUM[h.activeDex];
  el.innerHTML =
    `<h2>Active hunt</h2>` +
    `<div class="dash-hunt-row">` +
      `<img class="dash-hunt-sprite" src="${spriteUrl(h.activeDex, true)}" alt="" />` +
      `<div class="dash-hunt-meta">` +
        `<div class="dash-hunt-name">${sp ? sp.name.replace(/-/g, " ") : ""} ` +
          `<span class="muted">#${String(h.activeDex).padStart(4, "0")} · ${MODE_NAME[h.mode]}</span></div>` +
        `<div class="dash-hunt-count">${s.count}</div>` +
        `<div class="odds-readout">${huntOddsLine(s)}</div>` +
      `</div>` +
    `</div>` +
    `<button class="increment-btn" id="dash-inc">+1</button>` +
    `<div class="controls" style="justify-content:center">` +
      `<button class="ctrl-btn" id="dash-dec" title="Subtract one">−1</button>` +
      `<button class="ctrl-btn shiny" id="dash-found" title="Log the shiny &amp; mark ✨ Shiny">✨ Found!</button>` +
      `<button class="ctrl-btn good" id="dash-boxed" title="Log the shiny &amp; mark 📦 Boxed">📦 Boxed!</button>` +
      `<button class="ctrl-btn" data-gotab="hunt">Open Hunt →</button>` +
    `</div>`;
}

function renderDashProgress() {
  const el = document.getElementById("dash-progress");
  if (!el) return;
  let caught = 0, shiny = 0, boxed = 0;
  const genTot = {}, genBox = {};
  for (const sp of SPECIES) {
    const st = dexState(sp.dex);
    if (st === "caught" || st === "shiny" || st === "boxed") caught++;
    if (st === "shiny" || st === "boxed") shiny++;
    if (st === "boxed") boxed++;
    genTot[sp.gen] = (genTot[sp.gen] || 0) + 1;
    if (st === "boxed") genBox[sp.gen] = (genBox[sp.gen] || 0) + 1;
  }
  const total = SPECIES.length || 1;
  const shinyPct = ((shiny / total) * 100).toFixed(1);
  const boxPct = ((boxed / total) * 100).toFixed(1);
  const genRows = Object.keys(genTot).sort((a, b) => a - b).map((g) => {
    const b = genBox[g] || 0, t = genTot[g], p = ((b / t) * 100).toFixed(0);
    return `<div class="gen-row"><span class="gen-lbl">Gen ${g}</span>` +
      `<div class="bar"><i style="width:${p}%"></i></div><span class="gen-num">${b}/${t}</span></div>`;
  }).join("");
  el.innerHTML =
    `<h2>Living dex progress</h2>` +
    `<div class="dash-stat-line"><span class="stat"><b>${shiny}</b>/${total} shiny <span class="muted">(${shinyPct}%)</span></span></div>` +
    `<div class="bar big"><i style="width:${shinyPct}%"></i></div>` +
    `<div class="dash-stat-line">` +
      `<span class="stat">📦 boxed <b>${boxed}</b> <span class="muted">(${boxPct}%)</span></span>` +
      `<span class="stat">caught <b>${caught}</b></span>` +
      `<span class="stat">✨ logged <b>${state.hunt.finds.length}</b></span>` +
    `</div>` +
    `<details class="dash-gens"><summary class="summary-h">Per-generation boxed</summary>${genRows}</details>`;
}

function renderDashGaps() {
  const el = document.getElementById("dash-gaps");
  if (!el) return;
  const gaps = [];
  for (const sp of SPECIES) {
    if (dexState(sp.dex) !== "boxed") { gaps.push(sp); if (gaps.length >= 8) break; }
  }
  if (!gaps.length) {
    el.innerHTML = `<h2>Next to box</h2><p class="hint">Living dex complete — every species boxed! ✨</p>`;
    return;
  }
  el.innerHTML =
    `<h2>Next to box <span class="muted">— your next ${gaps.length} gaps</span></h2>` +
    `<div class="dash-gaps-row">` + gaps.map((sp) => {
      const nm = sp.name.replace(/-/g, " ");
      return `<div class="dash-gap" data-dex="${sp.dex}" role="button" tabindex="0" title="Jump to ${nm} in Boxes">` +
        `<button class="dash-gap-hunt" data-dex="${sp.dex}" title="Start a hunt for ${nm}">🎯</button>` +
        `<button class="dash-gap-box" data-dex="${sp.dex}" title="Mark ${nm} boxed">📦</button>` +
        `<img loading="lazy" src="${spriteUrl(sp.dex, true)}" alt="${sp.name}" />` +
        `<span class="dash-gap-no">#${String(sp.dex).padStart(4, "0")}</span>` +
        `<span class="dash-gap-nm">${nm}</span>` +
      `</div>`;
    }).join("") + `</div>`;
}

/* ---------- Progress goals (user-defined targets) ----------
 * Each goal is a small typed record in state.goals; GOAL_TYPES says how to label
 * it and how to compute {have, need} live from the dex/collection state, so a goal
 * never stores a stale count — it always reflects current progress. */
const STARTER_DEX = [1, 4, 7, 152, 155, 158, 252, 255, 258, 387, 390, 393,
  495, 498, 501, 650, 653, 656, 722, 725, 728, 810, 813, 816, 906, 909, 912];

function isShinyDex(dex) { const s = dexState(dex); return s === "shiny" || s === "boxed"; }
function isBoxedDex(dex) { return dexState(dex) === "boxed"; }
function speciesInGen(gen) { return SPECIES.filter((s) => s.gen === gen); }

const GOAL_TYPES = {
  "dex-shiny": { icon: "✨", label: () => "Full shiny dex",
    eval: () => ({ have: SPECIES.filter((s) => isShinyDex(s.dex)).length, need: SPECIES.length }) },
  "gen-shiny": { icon: "✨", needsGen: true, label: (g) => `Gen ${g.gen} shiny dex`,
    eval: (g) => { const l = speciesInGen(g.gen); return { have: l.filter((s) => isShinyDex(s.dex)).length, need: l.length }; } },
  "dex-boxed": { icon: "📦", label: () => "Box the living dex",
    eval: () => ({ have: SPECIES.filter((s) => isBoxedDex(s.dex)).length, need: SPECIES.length }) },
  "gen-boxed": { icon: "📦", needsGen: true, label: (g) => `Box all of Gen ${g.gen}`,
    eval: (g) => { const l = speciesInGen(g.gen); return { have: l.filter((s) => isBoxedDex(s.dex)).length, need: l.length }; } },
  "count-boxed": { icon: "📦", needsTarget: true, label: (g) => `Box ${g.target} shinies`,
    eval: (g) => ({ have: SPECIES.filter((s) => isBoxedDex(s.dex)).length, need: g.target }) },
  "count-shiny": { icon: "✨", needsTarget: true, label: (g) => `Catch ${g.target} shinies`,
    eval: (g) => ({ have: SPECIES.filter((s) => isShinyDex(s.dex)).length, need: g.target }) },
  "starters": { icon: "🌱", label: () => "Shiny all starters",
    eval: () => ({ have: STARTER_DEX.filter(isShinyDex).length, need: STARTER_DEX.length }) },
  "legendary-shiny": { icon: "👑", label: () => "Shiny all legendaries",
    eval: () => { const l = (LEGENDS && LEGENDS.list) || []; return { have: l.filter((e) => state.legendaries[e.dex] === "shiny").length, need: l.length }; } },
  "variants-shiny": { icon: "🎨", label: () => "Shiny all variants",
    eval: () => { const l = allVariants(); return { have: l.filter((v) => state.variants[v.id] === "shiny").length, need: l.length }; } },
  "wishlist-shiny": { icon: "★", label: () => "Clear your wishlist",
    eval: () => {
      const sp = state.wishlist.filter(isShinyDex).length;
      const vw = (state.variantWishlist || []).filter((id) => state.variants[id] === "shiny").length;
      return { have: sp + vw, need: state.wishlist.length + (state.variantWishlist || []).length };
    } },
};
function goalSig(g) { return [g.type, g.gen || "", g.target || ""].join("|"); }
function goalLabel(g) { return GOAL_TYPES[g.type].label(g); }
function evalGoal(g) {
  const t = GOAL_TYPES[g.type];
  const { have, need } = t.eval(g);
  return { icon: t.icon, have, need, done: need > 0 && have >= need, pct: need > 0 ? Math.min(100, (have / need) * 100) : 0 };
}
function addGoal(g) {
  if (state.goals.some((x) => goalSig(x) === goalSig(g))) return false;
  g.id = "g" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  g.createdAt = Date.now();
  state.goals.push(g);
  save();
  return true;
}
function removeGoal(id) { state.goals = state.goals.filter((g) => g.id !== id); save(); }

function renderDashGoals() {
  const el = document.getElementById("dash-goals");
  if (!el) return;
  const head = `<div class="dash-goals-head"><h2>🎯 Goals</h2>
    <button class="ctrl-btn" id="goal-add-open">+ Add goal</button></div>`;
  const goals = state.goals || [];
  if (!goals.length) {
    el.innerHTML = head + `<p class="hint">Set yourself a target — finish a gen's shiny dex, box your first 100,
      shiny all the starters or legendaries, or clear your wishlist. Progress fills in here as you catch.</p>`;
    return;
  }
  // In-progress first (fullest bar first), completed goals sink to the bottom.
  const rows = goals.map((g) => ({ g, r: evalGoal(g) }))
    .sort((a, b) => (a.r.done - b.r.done) || (b.r.pct - a.r.pct))
    .map(({ g, r }) => {
      const cnt = r.done ? "Complete!" : r.need > 0 ? `${r.have}/${r.need}` : `${r.have} · nothing queued`;
      return `<div class="goal-row${r.done ? " goal-done" : ""}" data-goal="${g.id}">
        <div class="goal-top">
          <span class="goal-name">${r.done ? "✅" : r.icon} ${goalLabel(g)}</span>
          <span class="goal-cnt">${cnt}</span>
          <button class="goal-del" data-goal="${g.id}" title="Remove this goal" aria-label="Remove goal">✕</button>
        </div>
        <div class="bar"><i style="width:${r.pct}%"></i></div>
        ${r.done || r.need <= 0 ? "" : `<div class="goal-pct">${Math.round(r.pct)}%</div>`}
      </div>`;
    }).join("");
  el.innerHTML = head + `<div class="goal-list">${rows}</div>`;
}

/* Add-goal modal */
function buildGoalFromModal() {
  const type = document.getElementById("goal-type").value;
  const t = GOAL_TYPES[type] || {};
  const g = { type };
  if (t.needsGen) g.gen = Number(document.getElementById("goal-gen").value) || 1;
  if (t.needsTarget) g.target = Math.max(1, Math.floor(Number(document.getElementById("goal-target").value) || 0));
  return g;
}
function updateGoalModalFields() {
  const type = document.getElementById("goal-type").value;
  const t = GOAL_TYPES[type] || {};
  document.getElementById("goal-gen-field").hidden = !t.needsGen;
  document.getElementById("goal-target-field").hidden = !t.needsTarget;
  const g = buildGoalFromModal();
  const r = evalGoal(g);
  const exists = state.goals.some((x) => goalSig(x) === goalSig(g));
  document.getElementById("goal-preview").innerHTML =
    `<b>${t.icon} ${goalLabel(g)}</b> — currently ` +
    (r.need > 0 ? `${r.have}/${r.need} (${Math.round(r.pct)}%)` : "nothing queued yet") +
    (exists ? `<br><span class="goal-exists">⚠ Already tracking this goal.</span>` : "");
  document.getElementById("goal-add").disabled = exists;
}
function openGoalModal() {
  document.getElementById("goal-type").value = "gen-shiny";
  document.getElementById("goal-target").value = "100";
  updateGoalModalFields();
  document.getElementById("goal-modal").hidden = false;
}
function closeGoalModal() { document.getElementById("goal-modal").hidden = true; }

/* ---------- "What should I hunt next?" recommender (#12) ---------- */
// Static id maps (forms/variants by base dex) — built once; membership in
// state.forms / state.variants is read live so "still needed" stays current.
let FV_BY_DEX = null;
function fvIndex() {
  if (FV_BY_DEX) return FV_BY_DEX;
  const m = {};
  const add = (dex, key, id) => { (m[dex] = m[dex] || { formIds: [], variantIds: [] })[key].push(id); };
  if (FORMS) for (const k of ["mega", "primal", "gmax"]) for (const f of FORMS[k] || []) add(f.dex, "formIds", f.id);
  for (const v of allVariants()) if (v && v.dex) add(v.dex, "variantIds", v.id);
  FV_BY_DEX = m;
  return m;
}
// How many of a species' Mega/GMax forms + regional/cosmetic variants you still
// need (forms: not unlocked; variants: not yet shiny). null if none apply.
function fvNeed(dex) {
  const e = fvIndex()[dex];
  if (!e) return null;
  const formsNeed = e.formIds.filter((id) => !state.forms[id]).length;
  const varNeed = e.variantIds.filter((id) => state.variants[id] !== "shiny").length;
  const count = formsNeed + varNeed;
  return count ? count : null;
}
// Best (most common) wild rarity a species reaches, across all its spawn entries.
// null = no natural wild spawn at all. Cached — spawn data is static.
let BEST_RARITY = null;
function bestRarityByDex() {
  if (BEST_RARITY) return BEST_RARITY;
  const m = {};
  for (const dex in SPAWNS) {
    let best = null;
    for (const e of SPAWNS[dex]) {
      const r = RARITY_ORDER[e.r];
      if (r == null) continue;
      if (best == null || r < best) best = r;
    }
    if (best != null) m[Number(dex)] = best;
  }
  BEST_RARITY = m;
  return m;
}
const RARITY_NAME = ["common", "uncommon", "rare", "ultra-rare"];
// Rank not-yet-shiny species by a blend of the signals the user cares about.
// Each matched signal adds score AND a reason chip, so the ranking is transparent.
function huntSuggestions(biome, limit = 8) {
  const hasShiny = (st) => st === "shiny" || st === "boxed";
  const attr = {};          // dex -> per-roll spawn/lure odds in this biome
  const inBiome = {};       // dex -> best rarity order in this biome
  const formsByDex = {};    // dex -> Set of forms that spawn here ("" = base form)
  const dpHere = {};        // dex -> datapack id if ALL its spawns here need a datapack
  if (biome && (BIOME_INDEX[biome] || isIngameBiome(biome))) {
    for (const a of computeAttraction(biome, [], true)) attr[a.dex] = a.p;
    // Only count species that EXPLICITLY list this biome — not the "any overworld"
    // / "any biome" wildcards (biomePool folds those in). Those pseudo-spawns are
    // too generic and would put mons like Terapagos/Meltan on every biome's list.
    // (Wishlisted mons still pass the gate below regardless.)
    for (const { dex, entry } of biomeSpecificPool(biome)) {
      const r = RARITY_ORDER[entry.r];
      if (r == null) continue;
      if (inBiome[dex] == null || r < inBiome[dex]) inBiome[dex] = r;
      (formsByDex[dex] = formsByDex[dex] || new Set()).add(entry.f || "");
      if (entry.dp) { if (!(dex in dpHere)) dpHere[dex] = entry.dp; }
      else dpHere[dex] = null; // a non-datapack spawn exists here → not gated
    }
  }
  const bestR = bestRarityByDex();
  const firstGap = SPECIES.find((sp) => !hasShiny(dexState(sp.dex)));
  const firstGapDex = firstGap ? firstGap.dex : null;

  const out = [];
  for (const sp of SPECIES) {
    const dex = sp.dex;
    if (hasShiny(dexState(dex))) continue; // only suggest shinies you still need
    const wished = state.wishlist.includes(dex);
    const here = inBiome[dex] != null;
    // Only weight things you can actually hunt here — unless you've wishlisted it,
    // which always keeps it in the running regardless of the current biome.
    if (!here && !wished) continue;
    // Tier drives the primary ordering: "spawns here" outranks a wishlist-only
    // pick, and wishlisted mons that ALSO spawn here float to the very top — so
    // picking a biome highlights which of your wishlist you can hunt right now.
    const tier = (wished && here) ? 3 : here ? 2 : 1;
    let score = 0;
    const reasons = [];
    if (wished) { score += 60; reasons.push({ i: "★", t: here ? "Wishlist — here!" : "Wishlist", c: "r-wl" }); }
    if (dex === firstGapDex) { score += 35; reasons.push({ i: "📦", t: "Next box gap", c: "r-gap" }); }
    if (inBiome[dex] != null) {
      score += 22;
      const p = attr[dex] || 0;
      score += Math.min(20, p * 200);
      const pct = p > 0 ? (p * 100).toFixed(p * 100 < 1 ? 2 : 1) + "%" : null;
      reasons.push({ i: "📍", t: `Spawns here · ${RARITY_NAME[inBiome[dex]]}${pct ? ` · 🍪 ${pct}` : ""}`, c: "r-biome" });
      if (dpHere[dex]) reasons.push({ i: "📦", t: `needs ${dpName(dpHere[dex])}`, c: "r-dp" });
    }
    const fv = fvNeed(dex);
    if (fv) { score += 18; reasons.push({ i: "✦", t: `${fv} form/variant${fv > 1 ? "s" : ""} to get`, c: "r-fv" }); }
    if (isLegendary(dex)) { score += 30; reasons.push({ i: "👑", t: "Legendary", c: "r-leg" }); }
    // Commonness: the MORE common a spawn is, the faster it shiny-hunts, so it ranks
    // HIGHER (replaces the old "rarer ranks higher" bonus). Weight the rarity at this
    // spot; for a wishlist-only pick use its best rarity elsewhere at half weight.
    const cr = here ? inBiome[dex] : bestR[dex];
    if (cr != null) {
      score += (here ? 1 : 0.5) * [18, 12, 6, 0][cr]; // common→+18 … ultra-rare→0
      // here-mons already show rarity in their 📍 chip; add ⚡ for common/uncommon to
      // surface the priority, and a 💎 only for wishlist-only picks (no 📍 chip).
      if (here && cr <= 1) reasons.push({ i: "⚡", t: `${RARITY_NAME[cr]} — fast hunt`, c: "r-common" });
      else if (!here && cr >= 2) reasons.push({ i: "💎", t: RARITY_NAME[cr], c: cr === 3 ? "r-hard" : "r-rare" });
    }
    const bst = COACH[dex] && COACH[dex].bst;
    if (bst >= 600 && !isLegendary(dex)) { score += 12; reasons.push({ i: "🌟", t: "High value", c: "r-bst" }); }

    if (score > 0) out.push({ dex, sp, score, reasons, tier, hot: wished && here, forms: formsByDex[dex] ? [...formsByDex[dex]] : [] });
  }
  out.sort((a, b) => b.tier - a.tier || b.score - a.score || a.dex - b.dex);
  return out.slice(0, limit);
}
function defaultHuntBiome() {
  const hb = state.config.huntBiome;
  if (hb && (BIOME_INDEX[hb] || isIngameBiome(hb))) return hb;
  const biomes = Object.keys(BIOME_INDEX).sort();
  return biomes.includes("forest") ? "forest" : biomes[0];
}
function renderDashNext() {
  const el = document.getElementById("dash-next");
  if (!el) return;
  const biomes = Object.keys(BIOME_INDEX).sort();
  if (!biomes.length) { el.innerHTML = `<h2>🎯 What should I hunt next?</h2><p class="hint">Spawn data unavailable.</p>`; return; }
  const biome = defaultHuntBiome();
  const opts = biomeSelectOptions(biome);
  const sugg = huntSuggestions(biome, 8);
  const hotN = sugg.filter((s) => s.hot).length;
  const head = `<h2>🎯 What should I hunt next? <span class="muted">— ranked for you</span></h2>
    <label class="field" style="margin:4px 0 ${hotN ? 4 : 10}px">Your current biome
      <select id="dash-next-biome" class="select" style="width:100%">${opts}</select></label>` +
    (hotN ? `<p class="hint" style="margin:0 0 10px">★ <strong>${hotN}</strong> of your wishlist ${hotN === 1 ? "spawns" : "spawn"} in <strong>${isIngameBiome(biome) ? biomeLabel(biome) : biome}</strong> — highlighted below.</p>` : "");
  if (!sugg.length) {
    el.innerHTML = head + `<p class="hint">No standout targets here — you've shiny'd everything that scores in this biome. Try another biome, check your ★ wishlist, or 🎲 Surprise me.</p>`;
    return;
  }
  el.innerHTML = head + `<div class="next-list">` + sugg.map((s) => {
    const nm = s.sp.name.replace(/-/g, " ");
    const chips = s.reasons.map((r) => `<span class="next-reason ${r.c}">${r.i} ${r.t}</span>`).join("");
    // Forms/variants that spawn here. If more than one, a clickable "+N form/variant"
    // chip expands the list so the extra forms can be seen (and hunted, if tracked).
    const forms = s.forms || [];
    let formsChip = "", formsPanel = "";
    if (forms.length > 1) {
      formsChip = `<span class="next-reason r-fv next-forms-toggle" role="button" tabindex="0" title="Show the other forms that spawn here">✦ +${forms.length - 1} form/variant ▾</span>`;
      formsPanel = `<div class="next-forms" hidden>` + forms.map((f) => {
        const v = f ? spawnVariant(s.dex, f) : null;
        const art = v ? variantArt(v, true).src : spriteUrl(s.dex, true);
        const label = f || "Base";
        const attrs = v ? `data-variant="${v.id}"` : `data-dex="${s.dex}"`;
        return `<button class="next-form${v ? " huntable" : ""}" ${attrs} title="Hunt ${nm} · ${label}">` +
          `<img loading="lazy" src="${art}" onerror="this.onerror=null;this.src='${spriteUrl(s.dex, true)}'" alt=""/><span>${label}</span></button>`;
      }).join("") + `</div>`;
    }
    return `<div class="find-row next-row${s.hot ? " next-hot" : ""}" data-dex="${s.dex}">` +
      `<img loading="lazy" src="${spriteUrl(s.dex, true)}" alt="${s.sp.name}" />` +
      `<div class="next-main"><div class="next-name">${nm} <span class="muted">#${String(s.dex).padStart(4, "0")}</span></div>` +
      `<div class="next-reasons">${chips}${formsChip}</div>${formsPanel}</div>` +
      `<button class="ctrl-btn good next-hunt" data-dex="${s.dex}" title="Start hunting ${nm}">🎯 Hunt</button>` +
    `</div>`;
  }).join("") + `</div>`;
}

function renderDashFinds() {
  const el = document.getElementById("dash-finds");
  if (!el) return;
  const finds = state.hunt.finds;
  if (!finds.length) {
    el.innerHTML = `<h2>Recent finds</h2><p class="hint">No shinies logged yet — go get one. ✨</p>`;
    return;
  }
  const recent = finds.slice(-5).reverse();
  el.innerHTML =
    `<h2>Recent finds <span class="muted">— ${finds.length} total</span>` +
    `<button class="ctrl-btn ghost dash-log-link" data-gotab="log" style="float:right">Full log →</button></h2>` +
    recent.map(findRowHtml).join("");
}

// Mark a species boxed straight from the dashboard's "next gaps" list.
function markBoxed(dex) {
  state.dex[String(dex)] = "boxed";
  save(); renderDex(); renderBoxes(); refreshDashboard(); refreshStats();
}

/* ---------- stats & milestones (#5) ---------- */
function dexCounts() {
  let caught = 0, shiny = 0, boxed = 0;
  const genTot = {}, genBox = {};
  for (const sp of SPECIES) {
    const st = dexState(sp.dex);
    if (st === "caught" || st === "shiny" || st === "boxed") caught++;
    if (st === "shiny" || st === "boxed") shiny++;
    if (st === "boxed") boxed++;
    genTot[sp.gen] = (genTot[sp.gen] || 0) + 1;
    if (st === "boxed") genBox[sp.gen] = (genBox[sp.gen] || 0) + 1;
  }
  return { caught, shiny, boxed, genTot, genBox, total: SPECIES.length };
}

function refreshStats() {
  const p = document.getElementById("panel-stats");
  if (p && p.classList.contains("active")) renderStats();
}
function renderStats() {
  renderStatsSummary();
  renderStatsTime();
  renderStatsMilestones();
}

// Compact reference to a find: sprite-less name + count + luck word.
function findRef(f) {
  const nm = (f.name || "").replace(/-/g, " ");
  const unit = f.mode === "breeding" ? " eggs" : f.mode === "chain" ? " KOs" : " enc.";
  const b = luckBadge(findLuckP(f));
  return `<b>${nm}</b> <span class="muted">(${f.count}${unit})</span> <span class="luck-chip ${b.cls}">${b.txt}</span>`;
}

// Reconcile logged finds with the Dex so OFF-HUNT catches are counted too: a shiny
// marked straight on a Dex card never creates a find, and logRandomCatch finds are
// flagged `random`. Total shiny catches = logged finds + shiny Dex species with no
// find at all; off-hunt = those unlogged ones + the logged "random" finds.
function shinyAccounting() {
  const finds = state.hunt.finds || [];
  const loggedDexes = new Set(finds.map((f) => f.dex));
  let unlogged = 0;
  for (const sp of SPECIES) {
    const s = dexState(sp.dex);
    if ((s === "shiny" || s === "boxed") && !loggedDexes.has(sp.dex)) unlogged++;
  }
  const randomN = finds.filter(isRandomFind).length;
  return { finds, unlogged, total: finds.length + unlogged, randomN, offHunt: randomN + unlogged };
}

function renderStatsSummary() {
  const el = document.getElementById("stats-summary");
  if (!el) return;
  const acc = shinyAccounting();
  const finds = acc.finds;
  const c = dexCounts();
  if (!acc.total) {
    el.innerHTML =
      `<h2>Stats</h2>` +
      `<div class="dash-stat-line">` +
        `<span class="stat"><b>${c.shiny}</b>/${c.total} shiny</span>` +
        `<span class="stat">📦 boxed <b>${c.boxed}</b></span>` +
        `<span class="stat">caught <b>${c.caught}</b></span>` +
      `</div>` +
      `<p class="hint">No shinies logged yet — log finds with ✨ Found! / 📦 Boxed! and your luck stats appear here.</p>`;
    return;
  }
  // Averages & luck cover tracked hunts only; off-hunt catches (logged-random +
  // Dex-marked) still count toward the shiny total but stay out of the encounter/luck maths.
  const tracked = finds.filter((f) => !isRandomFind(f));
  const byMode = { chain: 0, breeding: 0, encounter: 0 };
  let totalEnc = 0, best = null, worst = null;
  for (const f of tracked) {
    byMode[f.mode] = (byMode[f.mode] || 0) + 1;
    totalEnc += Number(f.count) || 0;
    const p = findLuckP(f);
    if (p == null) continue;
    if (!best || p > best.p) best = { f, p };
    if (!worst || p < worst.p) worst = { f, p };
  }
  const avg = tracked.length ? Math.round(totalEnc / tracked.length) : 0;
  el.innerHTML =
    `<h2>Stats <span class="muted">— ${acc.total} shiny${acc.offHunt ? ` · ${acc.offHunt} off-hunt` : ""}</span></h2>` +
    `<div class="dash-stat-line">` +
      `<span class="stat"><b>${c.shiny}</b>/${c.total} shiny</span>` +
      `<span class="stat">📦 boxed <b>${c.boxed}</b></span>` +
      `<span class="stat">caught <b>${c.caught}</b></span>` +
    `</div>` +
    `<div class="dash-stat-line">` +
      `<span class="stat">tracked hunts <b>${tracked.length}</b></span>` +
      `<span class="stat">total enc. <b>${totalEnc.toLocaleString()}</b></span>` +
      `<span class="stat">avg / shiny <b>${avg.toLocaleString()}</b></span>` +
      `<span class="stat">chain <b>${byMode.chain}</b> · breed <b>${byMode.breeding}</b> · enc <b>${byMode.encounter}</b>${acc.offHunt ? ` · off-hunt <b title="${acc.randomN} logged random + ${acc.unlogged} marked on the Dex">${acc.offHunt}</b>` : ""}</span>` +
    `</div>` +
    (best ? `<div class="stats-luck">` +
      `<div class="luck-line">🍀 Luckiest: ${findRef(best.f)}</div>` +
      `<div class="luck-line">💀 Unluckiest: ${findRef(worst.f)}</div>` +
    `</div>` : "");
}

function renderStatsTime() {
  const el = document.getElementById("stats-time");
  if (!el) return;
  const finds = state.hunt.finds;
  if (!finds.length) { el.innerHTML = `<h2>Finds over time</h2><p class="hint">No finds yet.</p>`; return; }
  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ y: d.getFullYear(), m: d.getMonth(), label: d.toLocaleString(undefined, { month: "short" }), count: 0 });
  }
  for (const f of finds) {
    const d = new Date(f.foundAt);
    const b = months.find((x) => x.y === d.getFullYear() && x.m === d.getMonth());
    if (b) b.count++;
  }
  const max = Math.max(1, ...months.map((b) => b.count));
  el.innerHTML =
    `<h2>Finds over time <span class="muted">— last 6 months</span></h2>` +
    `<div class="time-bars">` + months.map((b) =>
      `<div class="time-col" title="${b.count} in ${b.label}">` +
        `<span class="time-n">${b.count}</span>` +
        `<div class="time-bar" style="height:${Math.round((b.count / max) * 64) + 2}px"></div>` +
        `<span class="time-lbl">${b.label}</span>` +
      `</div>`).join("") + `</div>`;
}

function renderStatsMilestones() {
  const el = document.getElementById("stats-milestones");
  if (!el) return;
  const c = dexCounts();
  const finds = state.hunt.finds;
  const shinyN = shinyAccounting().total; // count milestones include off-hunt catches
  const tracked = finds.filter((f) => !isRandomFind(f)); // encounter/luck milestones ignore off-hunt catches
  const totalEnc = tracked.reduce((s, f) => s + (Number(f.count) || 0), 0);
  const gensComplete = Object.keys(c.genTot).filter((g) => (c.genBox[g] || 0) === c.genTot[g]).length;
  const bestLuck = tracked.reduce((m, f) => { const p = findLuckP(f); return p != null && p > m ? p : m; }, 0);
  const longest = tracked.reduce((m, f) => Math.max(m, Number(f.count) || 0), 0);
  const M = [
    { icon: "✨", title: "First Shiny", desc: "Catch your first shiny", done: shinyN >= 1, prog: `${shinyN}` },
    { icon: "🔟", title: "Perfect Ten", desc: "10 shinies caught", done: shinyN >= 10, prog: `${shinyN}/10` },
    { icon: "💯", title: "Centurion", desc: "100 shinies caught", done: shinyN >= 100, prog: `${shinyN}/100` },
    { icon: "🌟", title: "Shiny Charm", desc: "250 shinies caught", done: shinyN >= 250, prog: `${shinyN}/250` },
    { icon: "📦", title: "Box Filler", desc: "100 species boxed", done: c.boxed >= 100, prog: `${c.boxed}/100` },
    { icon: "🗺️", title: "Region Master", desc: "Complete a full generation", done: gensComplete >= 1, prog: `${gensComplete} gen${gensComplete === 1 ? "" : "s"}` },
    { icon: "🏆", title: "Living Legend", desc: `Box all ${c.total}`, done: c.boxed >= c.total, prog: `${c.boxed}/${c.total}` },
    { icon: "🍀", title: "Beginner's Luck", desc: "A find luckier than 95%", done: bestLuck >= 0.95, prog: `best ${Math.round(bestLuck * 100)}%` },
    { icon: "⛏️", title: "The Grind", desc: "A single hunt past 1,000", done: longest >= 1000, prog: `best ${longest.toLocaleString()}` },
    { icon: "🔥", title: "Dedicated Hunter", desc: "10,000 total encounters", done: totalEnc >= 10000, prog: `${totalEnc.toLocaleString()}` },
  ];
  const got = M.filter((m) => m.done).length;
  el.innerHTML =
    `<h2>Milestones <span class="muted">— ${got}/${M.length}</span></h2>` +
    `<div class="ms-grid">` + M.map((m) =>
      `<div class="ms-badge${m.done ? " done" : ""}" title="${m.desc}">` +
        `<span class="ms-icon">${m.icon}</span>` +
        `<span class="ms-title">${m.title}</span>` +
        `<span class="ms-desc">${m.desc}</span>` +
        `<span class="ms-prog">${m.done ? "✓ unlocked" : (m.prog || "")}</span>` +
      `</div>`).join("") + `</div>`;
}

function applyConfigInputs() {
  const base = Number(els.cfgBase.value);
  if (base > 0) state.config.baseShinyRate = base;
  const mas = Number(els.cfgMasuda.value);
  if (mas > 0) state.config.masudaMultiplier = mas;
  const parsed = (els.cfgThresholds.value || "").split(",").map((p) => {
    const m = p.trim().match(/^(\d+)\s*:\s*(\d+)$/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  }).filter(Boolean);
  if (parsed.length) state.config.unchainedThresholds = parsed.sort((a, b) => a[0] - b[0]);
  save(); fillConfigInputs(); renderHunt();
}
function fillConfigInputs() {
  els.cfgBase.value = state.config.baseShinyRate;
  els.cfgMasuda.value = state.config.masudaMultiplier;
  els.cfgThresholds.value = state.config.unchainedThresholds.map(([a, b]) => `${a}:${b}`).join(", ");
  if (els.huntRandomScope) els.huntRandomScope.value = state.config.randomScope || "smart";
  refreshHotkeyBtn();
}

/* ---------- configurable +1 hotkey ---------- */
let capturingHotkey = false;
// Friendly label for a KeyboardEvent.code (what we store, so it's layout-stable).
function hotkeyLabel(code) {
  if (!code) return "Off";
  const named = {
    Space: "Space", Enter: "Enter", Tab: "Tab", Backspace: "Backspace",
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
    NumpadAdd: "Numpad +", NumpadSubtract: "Numpad −", NumpadEnter: "Numpad Enter",
    NumpadMultiply: "Numpad ×", NumpadDivide: "Numpad ÷", NumpadDecimal: "Numpad .",
    Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
    Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\",
  };
  if (named[code]) return named[code];
  let m;
  if ((m = code.match(/^Key([A-Z])$/))) return m[1];
  if ((m = code.match(/^Digit(\d)$/))) return m[1];
  if ((m = code.match(/^Numpad(\d)$/))) return "Numpad " + m[1];
  return code; // F1…F12 and anything exotic show their raw code
}
function refreshHotkeyBtn() {
  if (!els.cfgHotkey) return;
  capturingHotkey = false;
  els.cfgHotkey.classList.remove("capturing");
  els.cfgHotkey.textContent = hotkeyLabel(state.config.huntHotkey);
  els.cfgHotkey.blur();
}

/* ---------- spawns tab ---------- */
let SPAWNS = {};        // dex -> [entry]
let BIOME_INDEX = {};   // biome -> [{dex, entry}]
const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, "ultra-rare": 3 };
let spawnMode = "mon";

// Cobbleverse marks a disabled wild spawn with a weight-0 row tagged the fake
// "not spawn" biome (e.g. Pikachu, which only comes from Pichu). Drop those so
// the species reports no wild spawn instead of leaking a bogus biome. (Legit
// weight-0 structure spawns have an empty `b` but a populated `st`, so are kept.)
function sanitizeSpawns() {
  for (const dex of Object.keys(SPAWNS)) {
    const rows = SPAWNS[dex].filter((e) => !(e.b || []).includes("not spawn"));
    if (rows.length) SPAWNS[dex] = rows; else delete SPAWNS[dex];
  }
}

// "any overworld" / "any biome" are catch-all categories (a mon spawns
// everywhere), not real places to AFK at — keep them as display chips but out
// of the reverse biome lookup so they don't drown the dropdown.
const PSEUDO_BIOMES = new Set(["any overworld", "any biome"]);
// Non-overworld biome labels. "any overworld" spawns occur in every biome EXCEPT
// these (Nether + End); "any biome" spawns occur everywhere.
const NON_OVERWORLD = new Set(["end", "basalt deltas", "crimson forest", "soul sand valley"]);
function isOverworldBiome(b) { return !/^nether\b/.test(b) && !NON_OVERWORLD.has(b) && !PSEUDO_BIOMES.has(b); }

// Overworld-wide ("any overworld") and all-biome ("any biome") spawns kept aside
// so the calculators can fold them into each concrete biome (see computeAttraction
// / computeSpawns). Keeps the per-biome browse view (renderSpawnByBiome) focused.
let PSEUDO_INDEX = { "any overworld": [], "any biome": [] };
function buildBiomeIndex() {
  BIOME_INDEX = {};
  PSEUDO_INDEX = { "any overworld": [], "any biome": [] };
  for (const dex in SPAWNS) {
    for (const e of SPAWNS[dex]) {
      for (const b of e.b) {
        if (PSEUDO_BIOMES.has(b)) { (PSEUDO_INDEX[b] = PSEUDO_INDEX[b] || []).push({ dex: Number(dex), entry: e }); continue; }
        (BIOME_INDEX[b] = BIOME_INDEX[b] || []).push({ dex: Number(dex), entry: e });
      }
    }
  }
}
// The spawn pool for a concrete biome, including overworld-/all-biome wildcards.
// ── In-game biome bridge ──────────────────────────────────────────────────
// Spawns key off Cobblemon biome LABELS ("temperate", "jungle"); the seed map and
// the world use concrete biome IDS ("minecraft:forest", "terralith:steppe"). These
// helpers let any selector/calculator accept either: a value with a ":" is an
// in-game biome id, expanded to the labels that cover it (from BIOME_SPAWNS).
let LABEL_BIOMES = null; // spawn label -> sorted [in-game biome ids it covers]
function buildLabelBiomes() {
  LABEL_BIOMES = {};
  for (const id in (BIOME_SPAWNS || {})) for (const l of BIOME_SPAWNS[id]) (LABEL_BIOMES[l] = LABEL_BIOMES[l] || []).push(id);
  for (const l in LABEL_BIOMES) LABEL_BIOMES[l].sort();
}
function isIngameBiome(sel) { return typeof sel === "string" && sel.includes(":"); }
function ingameLabels(id) { return ((BIOME_SPAWNS && BIOME_SPAWNS[id]) || []).filter((l) => l !== "any overworld"); }
function biomeIsOverworld(sel) { return isIngameBiome(sel) ? ((BIOME_SPAWNS && BIOME_SPAWNS[sel]) || []).includes("any overworld") : isOverworldBiome(sel); }
// Biome-specific spawn pool (no "any overworld"/"any biome" wildcards) for a label
// OR an in-game biome id (union of its labels, deduped by spawn entry).
function biomeSpecificPool(sel) {
  if (!isIngameBiome(sel)) return BIOME_INDEX[sel] || [];
  const seen = new Set(), out = [];
  for (const l of ingameLabels(sel)) for (const x of (BIOME_INDEX[l] || [])) {
    if (!seen.has(x.entry)) { seen.add(x.entry); out.push(x); }
  }
  return out;
}
function biomePool(biome) {
  let pool = biomeSpecificPool(biome).concat(PSEUDO_INDEX["any biome"] || []);
  if (biomeIsOverworld(biome)) pool = pool.concat(PSEUDO_INDEX["any overworld"] || []);
  return pool;
}
// <select> options for biome pickers: in-game biomes (real world) + categories (tags).
function biomeSelectOptions(selected) {
  const cat = Object.keys(BIOME_INDEX).sort()
    .map((b) => `<option value="${b}"${b === selected ? " selected" : ""}>${b} (${BIOME_INDEX[b].length})</option>`).join("");
  let ig = "";
  if (BIOME_SPAWNS) ig = Object.keys(BIOME_SPAWNS).filter((id) => ingameLabels(id).length).sort((a, b) => biomeLabel(a).localeCompare(biomeLabel(b)))
    .map((id) => `<option value="${id}"${id === selected ? " selected" : ""}>${biomeLabel(id)} (${biomeSpecificPool(id).length})</option>`).join("");
  return (ig ? `<optgroup label="🌍 In-game biomes">${ig}</optgroup>` : "") + `<optgroup label="🏷 Spawn categories">${cat}</optgroup>`;
}
// In-game biomes a spawn entry's labels expand to (for the by-Pokémon view).
function entryIngameBiomes(e) {
  if (!LABEL_BIOMES) return [];
  const s = new Set();
  for (const b of (e.b || [])) if (!PSEUDO_BIOMES.has(b)) for (const id of (LABEL_BIOMES[b] || [])) s.add(id);
  return [...s].sort((a, b) => biomeLabel(a).localeCompare(biomeLabel(b)));
}

function rarityChip(r) { return `<span class="r-chip r-${r}">${r}</span>`; }

// Quest-gated legendaries/mythicals: how you actually obtain them in Cobbleverse
// (gating item + radar to find the structure + trainer prerequisite).
function questHtml(q) {
  const bits = [];
  if (q.item) bits.push(`use <b>${q.item}</b>`);
  if (q.radar) bits.push(`radar: ${q.radar}`);
  if (q.prereq) bits.push(`after <b>${q.prereq}</b>`);
  let s = `<div class="spawn-quest">🧩 Quest summon${bits.length ? " — " + bits.join(" · ") : ""}`;
  if (q.biome) s += `<br>🗺 Structure biome: <b>${q.biome}</b>`;
  if (q.where) s += `<br><span class="muted">${q.where}</span>`;
  return s + `</div>`;
}
function biomeChip(b) {
  // Pseudo-biomes aren't clickable (they aren't in the reverse lookup).
  return PSEUDO_BIOMES.has(b)
    ? `<span class="struct-chip">🌍 ${b}</span>`
    : `<span class="biome-chip" data-biome="${b}">${b}</span>`;
}
// Regional / functional form this spawn row belongs to (Galarian, East Sea, …).
function formChip(f) { return `<span class="form-chip">✦ ${f}</span>`; }

// Spawn entries that only exist because a server-side datapack adds them. The
// `dp` flag carries which one, so the UI can warn it won't spawn without it.
const DP_LABEL = { "legendary-encounters": "Legendary Encounters datapack" };
function dpName(dp) { return DP_LABEL[dp] || "a server datapack"; }
function dpNoteHtml(dp) {
  return `<div class="dp-note" title="These spawns only exist with this datapack installed on the server.">📦 Requires the <b>${dpName(dp)}</b></div>`;
}
function entryDetail(e) {
  const bits = [];
  if (e.lv) bits.push(`Lv ${e.lv}`);
  if (e.t) bits.push(`🕘 ${e.t}`);
  if (e.wx) bits.push(`🌧 ${e.wx.join("/")}`);
  if (e.sky === true) bits.push("needs sky");
  if (e.sky === false) bits.push("underground");
  if (e.pos && e.pos !== "grounded") bits.push(e.pos);
  // Presets/structures are the headline location when there's no biome (rendered
  // as chips); only repeat them in the detail line when a biome leads.
  if (e.px && e.b.length) bits.push(`📍 ${e.px.join(", ")}`);
  if (e.st && e.b.length) bits.push(`🏛 ${e.st.join(", ")}`);
  if (e.bo) bits.push(e.bo.join(" "));
  return bits.join(" · ");
}

// Split one spawn entry's environmental requirements (things you must arrange to
// force the spawn) from weight-multiplier boosts (×N notes that only re-weight,
// not gate). Used by the best-place planner so you know how to set the scene.
function entryConditions(e) {
  const need = [], boost = [];
  if (e.t) need.push(`🕘 ${e.t}`);
  if (e.wx) need.push(`🌧 ${e.wx.join("/")}`);
  if (e.sky === true) need.push("☀️ open sky");
  if (e.sky === false) need.push("⛰️ no sky (underground)");
  if (e.pos && e.pos !== "grounded") need.push(`📐 ${e.pos}`);
  for (const n of e.bo || []) {
    if (/^×/.test(n)) { boost.push(n); continue; }
    if (/light [\d≤]|block light/.test(n)) need.push(`💡 ${n}`);
    else if (/^near /.test(n)) need.push(`🧱 ${n}`);
    else if (/^Y[ ≤≥]/.test(n)) need.push(`📏 ${n}`);
    else if (/^moon /.test(n)) need.push(`🌙 ${n}`);
    else need.push(n); // 🎣 fishing, slime chunk, …
  }
  return { need, boost };
}

// HTML block listing the conditions to force-spawn `dex` in `biome` (matches the
// entries the planner actually counted — those explicitly listing the biome).
function spawnConditionsHtml(dex, biome) {
  // For an in-game biome id, an entry applies if any of its tag labels covers the biome
  // (or a matching wildcard); for a plain label, exact membership.
  const ig = isIngameBiome(biome);
  const blabels = ig ? new Set(ingameLabels(biome)) : null;
  const owWild = ig && biomeIsOverworld(biome);
  const entries = (SPAWNS[dex] || []).filter((e) => ig
    ? (e.b || []).some((b) => blabels.has(b) || b === "any biome" || (owWild && b === "any overworld"))
    : (e.b || []).includes(biome));
  if (!entries.length) return "";
  const seen = new Set(), lines = [];
  for (const e of entries) {
    const { need, boost } = entryConditions(e);
    const body = need.length ? need.join(" · ") : "no special conditions — any time / light";
    const extra = boost.length ? ` <span class="muted">(boost: ${boost.join(", ")})</span>` : "";
    const line = `<li><span class="muted">Lv ${e.lv || "?"}, ${e.r}:</span> ${body}${extra}</li>`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return `<div class="plan-cond"><div class="plan-cond-h">To force this spawn here:</div>
    <ul class="plan-cond-list">${lines.join("")}</ul></div>`;
}

function renderSpawnByMon(dex) {
  const sp = DEX_BY_NUM[dex];
  const rows = SPAWNS[dex];
  if (!rows) {
    return `<div class="card"><div class="find-row"><img src="${spriteUrl(dex)}" alt=""/>
      <span class="find-name">${sp ? sp.name.replace(/-/g, " ") : "#" + dex}</span></div>
      <p class="hint">No wild spawn, raid, or quest in the Cobbleverse data. Obtained via evolution,
      breeding, or a craft (e.g. Type: Null → Silvally), trade, or a special event.</p></div>`;
  }
  // "Best spot" = entry with the highest weight (biome name, or structure/site
  // for legendaries that only appear at a fixed location).
  const best = rows.slice().sort((a, b) => (b.w || 0) - (a.w || 0))[0];
  const bestLoc = best ? (best.b[0] || (best.st && best.st[0])) : null;
  const bestLine = bestLoc
    ? `<p class="hint">⭐ ${best.b.length ? "Best AFK spot" : "Find at"}: <b>${bestLoc}</b> (${best.r}${best.t ? ", " + best.t : ""})</p>` : "";
  const list = rows
    .sort((a, b) => RARITY_ORDER[a.r] - RARITY_ORDER[b.r] || (b.w || 0) - (a.w || 0))
    .map((e) => {
      const loc = e.b.length
        ? e.b.map(biomeChip).join("")
        : e.st ? e.st.map((s) => `<span class="struct-chip">🏛 ${s}</span>`).join("")
        : e.px ? e.px.map((p) => `<span class="struct-chip">📍 ${p}</span>`).join("")
        : e.raid ? `<span class="struct-chip">⚔ Raid Den boss</span>`
        : e.q ? `<span class="struct-chip">🧩 Quest summon</span>`
        : `<span class="muted">special / event</span>`;
      const meta = entryDetail(e);
      const ig = entryIngameBiomes(e); // concrete biomes these tag categories expand to
      const igLine = ig.length
        ? `<div class="spawn-ig" title="${ig.map(biomeLabel).join(", ")}">🌍 ${ig.slice(0, 12).map(biomeLabel).join(", ")}${ig.length > 12 ? ` +${ig.length - 12} more` : ""}</div>`
        : "";
      return `<div class="spawn-row">
      <div class="spawn-biomes">${e.f ? formChip(e.f) : ""}${loc}</div>
      ${igLine}
      ${meta || e.r ? `<div class="spawn-meta">${rarityChip(e.r)} <span class="muted">${meta}</span></div>` : ""}
      ${e.dp ? dpNoteHtml(e.dp) : ""}
      ${e.raid && e.b.length ? `<div class="spawn-quest">⚔ Also a Cobblemon <b>Raid Den boss</b></div>` : ""}
      ${e.q ? questHtml(e.q) : ""}
    </div>`;
    }).join("");
  return `<div class="card">
    <div class="find-row"><img src="${spriteUrl(dex, true)}" alt=""/>
      <span class="find-name">${sp ? sp.name.replace(/-/g, " ") : "#" + dex}</span>
      <button class="ctrl-btn hunt-link" data-dex="${dex}" style="margin-left:auto">🎯 Hunt</button></div>
    ${bestLine}${list}</div>`;
}

function renderSpawnByBiome(biome) {
  const list = biomeSpecificPool(biome).slice()
    .sort((a, b) => RARITY_ORDER[a.entry.r] - RARITY_ORDER[b.entry.r] || (b.entry.w || 0) - (a.entry.w || 0));
  if (!list.length) return `<div class="card"><p class="hint">Nothing indexed for that biome.</p></div>`;
  const cards = list.map(({ dex, entry }) => {
    const sp = DEX_BY_NUM[dex];
    const art = spawnCardArt(dex, entry); // variant render if this entry is a variant form
    return `<div class="mon" data-dex="${dex}" title="${entry.f ? entry.f + " · " : ""}${entryDetail(entry)}">
      <span class="badge r-${entry.r}">${entry.r[0].toUpperCase()}</span>
      <img loading="lazy" src="${art.src}" onerror="this.onerror=null;this.src='${art.fb}'" alt="${sp ? sp.name : dex}"/>
      <div class="dexno">#${String(dex).padStart(4, "0")}</div>
      <div class="nm">${sp ? sp.name.replace(/-/g, " ") : dex}</div>
      ${entry.f ? `<div class="form-tag">✦ ${entry.f}</div>` : ""}${entry.dp ? `<div class="form-tag dp-tag" title="Requires the ${dpName(entry.dp)} on the server">📦 DP</div>` : ""}</div>`;
  }).join("");
  const ow = (isIngameBiome(biome) ? biomeIsOverworld(biome) : isOverworldBiome(biome)) ? (PSEUDO_INDEX["any overworld"] || []).length : 0;
  const title = isIngameBiome(biome) ? biomeLabel(biome) : biome;
  const sub = `· ${list.length} biome-specific spawns${ow ? ` · +${ow} overworld-wide` : ""}${isIngameBiome(biome) ? ` · 🌍 in-game biome` : ""}`;
  return `<div class="card"><h2 style="text-transform:capitalize">${title} <span class="muted" style="font-weight:400">${sub}</span></h2></div>
    <div class="grid" id="spawn-biome-grid">${cards}</div>`;
}

function setSpawnMode(mode) {
  spawnMode = mode;
  document.querySelectorAll("#spawn-mode .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.smode === mode));
  document.getElementById("spawn-mon-controls").hidden = mode !== "mon";
  document.getElementById("spawn-biome-controls").hidden = mode !== "biome";
  els.spawnResults.innerHTML = "";
  if (mode === "biome") renderSpawnResults();
}
function renderSpawnResults() {
  if (spawnMode === "biome") {
    els.spawnResults.innerHTML = renderSpawnByBiome(els.spawnBiomeSelect.value);
  }
}
function findSpawnByInput(raw) {
  const q = String(raw || "").trim().toLowerCase().replace(/^#/, "");
  if (!q) return;
  let sp = SPECIES.find((s) => s.name === q);
  if (!sp && /^\d+$/.test(q)) sp = DEX_BY_NUM[Number(q)];
  if (!sp) sp = SPECIES.find((s) => s.name.startsWith(q));
  if (!sp) { alert(`No species matching "${raw}".`); return; }
  els.spawnResults.innerHTML = renderSpawnByMon(sp.dex);
}

/* ---------- farm tab ---------- */
function fmtDuration(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return "—";
  const totalMin = hours * 60;
  if (totalMin < 60) return `${Math.round(totalMin)} min`;
  if (hours < 24) return `${hours.toFixed(1)} h`;
  const days = hours / 24;
  if (days < 7) return `${days.toFixed(1)} days (${hours.toFixed(0)} h)`;
  return `${(days).toFixed(1)} days`;
}
// Encounters needed for a >=p chance of at least one shiny at 1/odds.
function encountersForProb(p, odds) {
  return Math.ceil(Math.log(1 - p) / Math.log(1 - 1 / odds));
}

function renderFarmApricorn() {
  const trees = Number(els.farmTrees.value) || 0;
  const growth = Number(els.farmGrowth.value) || 20;
  const yld = Number(els.farmYield.value) || 1;
  const perBall = Number(els.farmPerBall.value) || 1;
  const target = Number(els.farmTarget.value) || 0;

  const perHour = trees * yld * (60 / growth);   // ripens per hour = 60/growth
  const ballsHr = perHour / perBall;
  const targetHrs = perHour > 0 ? target / perHour : Infinity;

  els.farmApricornOut.innerHTML =
    `Output: <b>${perHour.toFixed(1)}</b> apricorns/hr · <b>${ballsHr.toFixed(1)}</b> balls/hr<br>` +
    `<span class="muted">${target} apricorns ≈ <b>${fmtDuration(targetHrs)}</b> of growth` +
    ` (${perHour > 0 ? Math.ceil(target / perHour) : "∞"} h, unattended)</span>`;
}

function renderFarmShiny() {
  const odds = Number(els.farmOdds.value) || 8192;
  const rate = Number(els.farmRate.value) || 0;   // per hour
  const mean = odds;                               // geometric mean attempts
  const rows = [["Expected (avg)", mean], ["50% chance", encountersForProb(0.5, odds)],
    ["90% chance", encountersForProb(0.9, odds)], ["99% chance", encountersForProb(0.99, odds)]];
  els.farmShinyOut.innerHTML =
    `<table class="farm-tbl"><tr><th></th><th>Encounters</th><th>Time @ ${rate}/hr</th></tr>` +
    rows.map(([label, n]) =>
      `<tr><td>${label}</td><td><b>${n.toLocaleString()}</b></td><td>${rate > 0 ? fmtDuration(n / rate) : "—"}</td></tr>`
    ).join("") + `</table>`;
}

function quickOdds(which) {
  if (which === "base") els.farmOdds.value = state.config.baseShinyRate;
  else if (which === "masuda") els.farmOdds.value = Math.round(state.config.baseShinyRate / state.config.masudaMultiplier);
  else if (which === "chainmax") {
    const maxBonus = Math.max(0, ...state.config.unchainedThresholds.map(([, b]) => b));
    els.farmOdds.value = Math.round(state.config.baseShinyRate / (maxBonus + 1));
  }
  renderFarmShiny();
}
function renderFarm() { renderFarmApricorn(); renderFarmShiny(); }

/* ---------- pokésnack tab ---------- */
/* Cobblemon 1.7: a Poké Snack draws Pokémon from the biome's spawn pool; the Bait
 * Seasonings cooked in bias which ones bite. We model the effects that decide
 * *which species* shows up — type and egg-group berries (×10 to a matching
 * species), EV-yield berries (force the pool to ONLY species yielding that EV),
 * plus rarity-tier boosts (shift the common→ultra-rare bucket
 * odds). The remaining seasonings (shiny, level, IV, nature, gender, ability) tune
 * the *traits* of who's attracted, not which species, so they're surfaced in the
 * summary but don't re-rank the list. */
let BERRIES = [];        // [{id,name,group,effect,type?,rarityTier?,shiny?,...}]
let BERRY_BY_ID = {};
let BERRY_GUIDE = [];    // [{id,name,kind,biomes,mulch,source,effect,img}] — Berries tab

// Natural world spawns use Cobbleverse's "Rarity Overhaul" global bucket weights
// (overrides base Cobblemon's 94/5/0.5/0.2 best-spawner-config). A placed Poké
// Snack instead follows the exact rarity-tier table below (RARITY_TIER_ODDS).
const WORLD_BUCKETS = { common: 88.5, uncommon: 10, rare: 1.2, "ultra-rare": 0.3 };

// Cobbleverse server config (lumymon.json) blacklists these dex from Poké Snack
// spawns — poke_snack_blacklist "custom" + "paradox" tags (legendaries, the
// treasures of ruin, Type: Null, Zygarde, and all paradox mons). They still spawn
// naturally; by default they just can't be lured by a snack.
const SNACK_BLACKLIST = new Set([144, 145, 146, 150, 151, 243, 244, 245, 249, 250, 251, 377, 378, 379, 380, 381, 382, 383, 384, 385, 386, 480, 481, 482, 483, 484, 485, 486, 487, 488, 489, 490, 491, 492, 493, 718, 772, 890, 894, 895, 896, 897, 898, 984, 985, 986, 987, 988, 989, 990, 991, 992, 993, 994, 995, 1001, 1002, 1003, 1004, 1005, 1006, 1009, 1010, 1020, 1021, 1022, 1023]);
// We ASSUME the blacklist has been disabled (so every Pokémon — legendaries
// included — can be snack-lured) and compute plans for all of them. Flip this to
// false to honour the stock blacklist instead. Mons in SNACK_BLACKLIST still get
// a small note that luring them is off by default.
const ASSUME_ALL_LURABLE = true;
const isSnackBlacklisted = (dex) => !ASSUME_ALL_LURABLE && SNACK_BLACKLIST.has(Number(dex));
const SNACK_LURE_NOTE = "Cobbleverse blocks Poké Snack lures for this Pokémon by default (lumymon blacklist); this plan assumes that's been turned off.";
const BUCKETS = ["common", "uncommon", "rare", "ultra-rare"];
// Poké Snack bucket math — decompiled exactly from Cobblemon's PokeSnackBlockEntity
// (Cobblemon-fabric-1.7.3+1.21.1). A placed snack adds two influences on top of the
// spawner's base bucket weights, applied in this order:
//   1. BucketNormalizingInfluence (ONLY if the seasonings' summed rarity tier > 0):
//      each weight → weight^(1 / (firstTier + gradient·(tier−1))), firstTier=1.2,
//      gradient=0.2 (so the divisor is 1.2 + 0.2·(tier−1) = 1.0 + 0.2·tier).
//   2. BucketMultiplyingInfluence (ALWAYS, even at tier 0): the per-bucket factors
//      below (common is absent from the map → left ×1).
// Then the buckets are normalised to probabilities. Base weights are the same
// WORLD_BUCKETS the spawner uses — Cobbleverse's Rarity Overhaul (88.5/10/1.2/0.3),
// NOT base Cobblemon's 94.3/5/0.5/0.2. The tiers reachable from 3 snack slots (each
// +1 or +10) are 0-3, 10-12, 20-21, 30, but this is exact for any tier.
const SNACK_MULT = { common: 1, uncommon: 2.25, rare: 5.5, "ultra-rare": 5.5 };
// Bucket probabilities (summing to 1). A placed snack applies the two influences
// above; natural world spawns just use the base weights (no snack = no influence).
function bucketOdds(tier, snack = true) {
  const w = {};
  for (const b of BUCKETS) w[b] = WORLD_BUCKETS[b];
  if (snack) {
    const t = Math.max(0, Math.round(tier));
    if (t > 0) { const d = 1.2 + 0.2 * (t - 1); for (const b of BUCKETS) w[b] = Math.pow(w[b], 1 / d); }
    for (const b of BUCKETS) w[b] *= SNACK_MULT[b];
  }
  const sum = BUCKETS.reduce((a, b) => a + w[b], 0) || 1;
  const out = {};
  for (const b of BUCKETS) out[b] = w[b] / sum;
  return out;
}

function selectedSeasonings() {
  return ["snack-s0", "snack-s1", "snack-s2"]
    .map((id) => document.getElementById(id).value)
    .filter(Boolean)
    .map((id) => BERRY_BY_ID[id])
    .filter(Boolean);
}

// Cobblemon's SpawnBaitInfluence.affectWeight applies the type/egg-group multiplier
// ONCE, not per seasoning: it takes the FIRST type seasoning (×10 if the species
// matches that type) and the FIRST egg seasoning whose group the species matches.
// EV-yield berries aren't a multiplier — they hard-filter the pool (see EV gate).
function snackMult(sp, seasonings) {
  if (!sp) return 1;
  let m = 1;
  const typeS = seasonings.find((s) => s.type);                       // first type seasoning
  if (typeS && sp.types.includes(typeS.type)) m *= 10;
  const eggS = seasonings.find((s) => s.eggGroups && sp.eggGroups && s.eggGroups.some((g) => sp.eggGroups.includes(g)));
  if (eggS) m *= 10;
  return m;
}

// EV-yield seasonings FORCE the spawn pool: Cobblemon only rolls species that
// yield a selected EV, dropping every other species' weight to 0. So this is a
// gate, not a ×10 bias. Returns the list of required EVs (empty = no EV gate).
function evRequirements(seasonings) {
  return [...new Set(seasonings.filter((s) => s.ev).map((s) => s.ev))];
}
function passesEvGate(sp, evReqs) {
  if (!evReqs.length) return true;                     // no EV seasoning → no gate
  return !!(sp && sp.ev && evReqs.some((ev) => sp.ev.includes(ev)));
}

// Aquatic spawns only roll where there's water at the placement spot, so a snack
// dropped on dry land can't draw them — only one placed at the water's edge can.
// Detected from the spawn position (submerged / seafloor / rod-fishing) or a
// "near <aquatic block>" nearby-block requirement carried in the `bo` notes.
// NOTE: position "surface" is deliberately excluded — land mobs (Grimer, Muk,
// Dratini…) use it too, so it doesn't reliably mean "on water".
const WATER_POS = new Set(["submerged", "seafloor", "fishing"]);
const WATER_BLOCK_RE = /water|kelp|seagrass|sea grass|coral|lily ?pad/i;
function needsWater(e) {
  if (e.pos && WATER_POS.has(e.pos)) return true;
  return !!(e.bo && e.bo.some((n) => /^near /i.test(n) && WATER_BLOCK_RE.test(n)));
}
// Fraction of a biome's spawns that require water — used to default the "near
// water" toggle ON for inherently aquatic biomes (ocean, river…).
function biomeWaterShare(biome) {
  const pool = biomeSpecificPool(biome);
  if (!pool.length) return 0;
  return pool.filter(({ entry }) => needsWater(entry)).length / pool.length;
}

function snackTotals(seasonings) {
  // Shiny modifiers stack ADDITIVELY: a "Nx" seasoning is a +(N-1) bonus, and the
  // bonuses sum. Starf (5x = +400%) + Enchanted Golden Apple (10x = +900%) = 14x,
  // not 50x. So total = 1 + Σ(bonus).
  let tier = 0, shinyBonus = 0, biteKeep = 1, level = 0;
  for (const s of seasonings) {
    tier += s.rarityTier || 0;
    if (s.shiny) shinyBonus += s.shiny - 1;
    if (s.biteTime) biteKeep *= 1 + s.biteTime; // biteTime is negative (a reduction)
    level += s.level || 0;
  }
  return { tier, shiny: 1 + shinyBonus, level, biteReduction: Math.round((1 - biteKeep) * 100) };
}

const typeChip = (t) => `<span class="type-chip">${t}</span>`;

function renderSnackSummary(seasonings) {
  const wrap = els.snackSummary;
  if (!seasonings.length) {
    wrap.innerHTML = `<p class="hint">No seasonings yet — the list below shows a <em>plain placed snack</em>
      (which already biases toward rarer mons than the wild: uncommon ×2.25, rare/ultra ×5.5). Add a
      <strong>type berry</strong> (e.g. Occa → Fire) to bias attraction, or a rarity item
      (Golden Apple, Enchanted Golden Apple…) to push the buckets further toward rare.</p>`;
    return;
  }
  const t = snackTotals(seasonings);
  const types = [...new Set(seasonings.filter((s) => s.type).map((s) => s.type))];
  const eggs = [...new Set(seasonings.flatMap((s) => s.eggGroups || []))];
  const evs = [...new Set(seasonings.filter((s) => s.ev).map((s) => s.ev))];
  const head = [];
  if (t.tier > 0) head.push(`<span class="snack-stat">Rarity <b>+${t.tier}</b></span>`);
  if (t.shiny > 1) head.push(`<span class="snack-stat">✨ shiny <b>×${t.shiny}</b> (+${(t.shiny - 1) * 100}%)</span>`);
  if (types.length) head.push(`<span class="snack-stat">Type bias ${types.map(typeChip).join(" ")}</span>`);
  if (eggs.length) head.push(`<span class="snack-stat">Egg group ${eggs.map(typeChip).join(" ")}</span>`);
  if (evs.length) head.push(`<span class="snack-stat">Only EV yield ${evs.map(typeChip).join(" ")}</span>`);
  if (t.level > 0) head.push(`<span class="snack-stat">Level <b>+${t.level}</b></span>`);
  if (t.biteReduction > 0) head.push(`<span class="snack-stat">Bite time <b>−${t.biteReduction}%</b></span>`);

  const chips = seasonings.map((s) =>
    `<div class="snack-chip"><b>${s.name}</b><span class="muted">${s.effect}</span></div>`).join("");

  // Note effects that flavour the catch but can't re-rank species (no per-species data).
  const traitOnly = seasonings.some((s) => s.nature || s.iv || s.gender || s.ability);
  const note = traitOnly
    ? `<p class="hint" style="margin-bottom:0">Nature, IV, gender and ability seasonings change the
       <em>traits</em> of the Pokémon that bite (not which species spawn), so they're listed here but don't reorder
       the visitors below.</p>` : "";

  wrap.innerHTML =
    `<h2>This snack favours</h2>` +
    `<div class="snack-head">${head.join("") || '<span class="muted">flavour only — no attraction change</span>'}</div>` +
    `<div class="snack-chips">${chips}</div>${note}`;
}

// Per-species attraction probability for a biome + seasonings. Returns a ranked
// array [{dex, p, boosted}]. p is the per-roll spawn chance (matches PokéNav:
// bucket odds × within-bucket weight share), so it can sum to <1 across the pool.
function computeAttraction(biome, seasonings, nearWater = true) {
  const pool = biomePool(biome);
  if (!pool.length) return [];
  const odds = bucketOdds(seasonings.reduce((a, s) => a + (s.rarityTier || 0), 0), true);

  // Bucket each spawn entry, weighted by spawn weight × type/egg multiplier.
  // EV-yield seasonings gate the pool: non-matching species are removed entirely.
  // Water-only spawns are gated on placement: dropped if the snack isn't near water.
  const evReqs = evRequirements(seasonings);
  const buckets = { common: [], uncommon: [], rare: [], "ultra-rare": [] };
  for (const { dex, entry } of pool) {
    if (!buckets[entry.r]) continue;
    if (isSnackBlacklisted(dex)) continue;              // lumymon: can't be lured by a snack (off by default — we assume all lurable)
    if (!nearWater && needsWater(entry)) continue;      // dry land — aquatic spawns can't roll
    const sp = DEX_BY_NUM[dex];
    if (!passesEvGate(sp, evReqs)) continue;            // forced out — can't be lured
    const mult = snackMult(sp, seasonings);
    const w = (entry.w || 0) * mult;   // weight-0 spawns don't roll, so they can't be lured
    if (w <= 0) continue;
    // A type/egg ×10 OR surviving an EV gate both mean the snack deliberately favours this species.
    buckets[entry.r].push({ dex, w, boosted: mult > 1 || evReqs.length > 0 });
  }
  // Cobblemon rolls a bucket by weight then a species within it; an empty bucket
  // just yields no spawn, so we use the raw bucket odds (no renormalising over
  // present buckets) — p is the true per-roll chance, matching PokéNav.
  const present = BUCKETS.filter((b) => buckets[b].length);

  const attraction = {}; // dex -> { p, boosted }
  for (const b of present) {
    const tot = buckets[b].reduce((a, x) => a + x.w, 0) || 1;
    const bucketProb = odds[b];
    for (const x of buckets[b]) {
      const cur = attraction[x.dex] || (attraction[x.dex] = { p: 0, boosted: false });
      cur.p += bucketProb * (x.w / tot);
      if (x.boosted) cur.boosted = true;
    }
  }
  return Object.entries(attraction)
    .map(([dex, v]) => ({ dex: Number(dex), ...v }))
    .sort((a, b) => b.p - a.p);
}

function renderSnackResults(ranked, note = "") {
  if (!ranked.length) {
    els.snackResults.innerHTML = `<div class="card"><p class="hint">${note ||
      "No spawn data indexed for this biome."}</p></div>`;
    return;
  }
  const max = ranked[0].p || 1;
  const top = ranked.slice(0, 30);
  const rows = top.map((r) => {
    const sp = DEX_BY_NUM[r.dex];
    const types = sp ? sp.types.map(typeChip).join(" ") : "";
    const pct = (r.p * 100).toFixed(1);
    return `<div class="snack-row" data-dex="${r.dex}">
      <img loading="lazy" src="${spriteUrl(r.dex)}" alt="${sp ? sp.name : r.dex}" />
      <div class="snack-row-main">
        <div class="snack-row-name">${sp ? sp.name.replace(/-/g, " ") : "#" + r.dex} ${types}
          ${r.boosted ? '<span class="snack-boost">▲ lured</span>' : ""}</div>
        <div class="bar"><i style="width:${(r.p / max) * 100}%"></i></div>
      </div>
      <div class="snack-pct">${pct}%</div>
    </div>`;
  }).join("");

  const more = ranked.length > top.length ? `<p class="hint">…and ${ranked.length - top.length} more rarer visitors.</p>` : "";
  els.snackResults.innerHTML = `${note}<div class="card snack-list">${rows}</div>${more}`;
}

const SNACK_BITES = 9; // a Poké Snack is eaten in 9 bites = 9 attracted Pokémon.
let snackRanked = [];  // current ranked attraction (cached so target/rate changes are cheap)
let snackTarget = "any";

// Rebuild the target dropdown from the current ranking, preserving the pick if still present.
function populateSnackTargets(ranked) {
  const prev = snackTarget;
  els.snackTarget.innerHTML = `<option value="any">Any species (any shiny)</option>` +
    ranked.slice(0, 30).map((r) => {
      const sp = DEX_BY_NUM[r.dex];
      return `<option value="${r.dex}">${(sp ? sp.name.replace(/-/g, " ") : "#" + r.dex)} — ${(r.p * 100).toFixed(1)}%</option>`;
    }).join("");
  if (prev !== "any" && ranked.some((r) => String(r.dex) === String(prev))) els.snackTarget.value = prev;
  else { snackTarget = "any"; els.snackTarget.value = "any"; }
}

function renderSnackShiny(seasonings) {
  if (!els.snackBaseRate.value) els.snackBaseRate.value = state.config.baseShinyRate;
  const baseRate = Number(els.snackBaseRate.value) || state.config.baseShinyRate;
  const shiny = snackTotals(seasonings).shiny;        // additive multiplier (e.g. 14)
  const effOdds = baseRate / shiny;                   // 1-in-N that any one bite is shiny

  if (!snackRanked.length) {
    els.snackShinyOut.innerHTML = `<span class="muted">Pick a biome with spawn data to estimate snacks.</span>`;
    return;
  }
  // Whole-pool ("any shiny") uses p = 1; a target species folds in how often it shows up.
  let p = 1, label = "Any shiny (whole pool)";
  if (snackTarget !== "any") {
    const r = snackRanked.find((x) => String(x.dex) === String(snackTarget));
    if (r) { p = r.p; const sp = DEX_BY_NUM[r.dex]; label = `${(sp ? sp.name.replace(/-/g, " ") : "#" + r.dex)} · ${(p * 100).toFixed(1)}% of visitors`; }
  }
  const targetOdds = effOdds / p;                     // 1-in-N that a bite is a shiny of the target
  const snacks = (enc) => Math.max(1, Math.ceil(enc / SNACK_BITES));
  const rows = [
    ["Expected (avg)", Math.round(targetOdds)],
    ["50% chance", encountersForProb(0.5, targetOdds)],
    ["90% chance", encountersForProb(0.9, targetOdds)],
    ["99% chance", encountersForProb(0.99, targetOdds)],
  ];
  const shinyNote = shiny > 1 ? ` (base 1/${baseRate} × ✨×${shiny})` : "";
  els.snackShinyOut.innerHTML =
    `Effective shiny odds <b>1/${Math.round(effOdds).toLocaleString()}</b> per Pokémon${shinyNote}<br>` +
    `<span class="muted">Target: ${label} → 1 shiny per <b>1/${Math.round(targetOdds).toLocaleString()}</b> bites</span>` +
    `<table class="farm-tbl" style="margin-top:10px"><tr><th></th><th>Pokémon (bites)</th><th>Snacks</th></tr>` +
    rows.map(([l, n]) =>
      `<tr><td>${l}</td><td><b>${n.toLocaleString()}</b></td><td>${snacks(n).toLocaleString()}</td></tr>`
    ).join("") + `</table>`;
}

// Note explaining how the "near water" placement is reshaping the pool.
function waterNote(biome, nearWater) {
  const pool = biomeSpecificPool(biome);
  const wet = pool.filter(({ entry }) => needsWater(entry)).length;
  if (!wet) return "";
  const s = wet > 1 ? "s" : "";
  return nearWater
    ? `<p class="hint">💧 Placed <b>near water</b>: ${wet} aquatic spawn${s} (submerged / fishing / near-water) are in the pool. Untick if you're on dry land.</p>`
    : `<p class="hint">🏜️ Placed on <b>dry land</b>: ${wet} water-only spawn${s} excluded and the odds renormalised. Tick “near water” to include them.</p>`;
}

function renderSnack() {
  if (!els.snackBiome) return;
  const biome = els.snackBiome.value;
  const seasonings = selectedSeasonings();
  const nearWater = !els.snackNearWater || els.snackNearWater.checked;
  snackRanked = computeAttraction(biome, seasonings, nearWater);
  renderSnackSummary(seasonings);
  renderSnackResults(snackRanked, waterNote(biome, nearWater));
  populateSnackTargets(snackRanked);
  renderSnackShiny(seasonings);
}

/* ---------- best place & snack optimiser ---------- */
/* Find the biome + ≤3 seasonings that get a shiny of a target in the fewest
 * snacks. Snacks-to-shiny ∝ 1/(p × shinyMult), so we maximise spawn-share p
 * times the shiny multiplier — jointly over every biome the species spawns in
 * and every seasoning multiset. Only seasonings that move those two levers are
 * candidates (matching type/egg/EV berries, and shiny/rarity boosters). */
function relevantSeasonings(sp, allowEGA) {
  const out = [], seen = new Set();
  for (const b of BERRIES) {
    let keep = false;
    if (b.type) keep = sp.types.includes(b.type);
    else if (b.eggGroups) keep = !!(sp.eggGroups && b.eggGroups.some((g) => sp.eggGroups.includes(g)));
    else if (b.ev) keep = !!(sp.ev && sp.ev.includes(b.ev));
    else if (b.shiny || b.rarityTier) keep = b.id === "enchanted-golden-apple" ? allowEGA : true;
    if (!keep) continue;
    // Collapse interchangeable boosters (same rarityTier+shiny) so combos stay small.
    const sig = b.type || (b.eggGroups && b.eggGroups.join("/")) || b.ev || `boost:${b.rarityTier || 0}:${b.shiny || 0}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(b);
  }
  return out;
}

// All multisets (with replacement) of size 0..maxK — the 3 slots can repeat a berry.
function multisetCombos(items, maxK) {
  const out = [[]];
  const rec = (start, cur) => {
    if (cur.length === maxK) return;
    for (let i = start; i < items.length; i++) {
      cur.push(items[i]);
      out.push(cur.slice());
      rec(i, cur);
      cur.pop();
    }
  };
  rec(0, []);
  return out;
}

const EGA_ID = "enchanted-golden-apple";
const egaCount = (combo) => combo.filter((b) => b.id === EGA_ID).length;
// The target's pool-shaping seasonings — type (×10), egg-group (×10) and EV-yield
// (hard gate) berries it matches. These change WHO competes (and so the target's
// share); pure shiny/rarity boosters don't, so they're left to phase 2.
function gateSeasonings(sp) {
  return relevantSeasonings(sp, false).filter((b) => b.type || b.eggGroups || b.ev).slice(0, 3);
}
// Seasoning combos for a species capped at `egaCap` Enchanted Golden Apples
// (0 = budget, 1 = one EGA, 3 = unlimited across the 3 slots).
function combosFor(sp, egaCap) {
  const combos = multisetCombos(relevantSeasonings(sp, egaCap > 0), 3);
  return egaCap >= 3 ? combos : combos.filter((c) => egaCount(c) <= egaCap);
}
// Choose which EGA tiers to show, collapsing ones where extra EGAs don't help.
// `plans` = { b0, b1, bMax } from egaCap 0 / 1 / 3. Returns labelled, de-duped tiers.
function egaTiers(b0, b1, bMax) {
  const max = bMax ? egaCount(bMax.combo) : 0;
  if (max === 0) return { tiers: [["Budget · no EGA", b0]], note: "egaNone" };
  if (max <= 1) return { tiers: [["Budget · no EGA", b0], ["With 1 EGA", b1]], note: "ega1" };
  return { tiers: [["Budget · no EGA", b0], ["Max 1 EGA", b1], [`Premium · ${max}× EGA`, bMax]], note: "" };
}
function egaNoteText(note, name) {
  if (note === "egaNone") return `<p class="hint">An Enchanted Golden Apple doesn't improve ${name}'s odds here — the rarity-tier shift costs more spawn share than the shiny boost gains — so there's just one plan.</p>`;
  if (note === "ega1") return `<p class="hint">One Enchanted Golden Apple is optimal for ${name}; stacking more doesn't help.</p>`;
  return "";
}

function bestSnackFor(dex, egaCap) {
  const sp = DEX_BY_NUM[dex];
  if (!sp) return null;
  const labels = [...new Set((SPAWNS[dex] || []).flatMap((e) => e.b))];
  // Search the IN-GAME biomes this species can spawn in, not the tag labels: the lure
  // odds depend on the WHOLE pool sharing a biome (everything tagged forest + temperate +
  // any-overworld), and a single label like "temperate" undercounts that competition, so
  // it over-states the spawn rate. In-game biomes give the accurate pool.
  let biomes;
  if (LABEL_BIOMES && BIOME_SPAWNS) {
    const set = new Set();
    for (const l of labels) {
      if (l === "any overworld" || l === "any biome") {
        const all = l === "any biome";
        for (const id in BIOME_SPAWNS) if (all || biomeIsOverworld(id)) set.add(id);
      } else for (const id of (LABEL_BIOMES[l] || [])) set.add(id);
    }
    biomes = [...set];
  } else {
    biomes = [...new Set(labels)].filter((b) => BIOME_INDEX[b]); // fallback: label-based
    if (labels.includes("any biome") || labels.includes("any overworld")) {
      const anyB = labels.includes("any biome");
      biomes = [...new Set(biomes.concat(Object.keys(BIOME_INDEX).filter((b) => anyB || isOverworldBiome(b))))];
    }
  }
  if (!biomes.length) return null;
  // Collapse biomes with an identical spawn pool (same label set) — same odds, so this
  // avoids recomputing for the many real biomes that share a pool (e.g. any-overworld mons).
  const bySig = new Map();
  for (const id of biomes) {
    const sig = isIngameBiome(id) ? ingameLabels(id).slice().sort().join("|") + (biomeIsOverworld(id) ? "#ow" : "") : id;
    if (!bySig.has(sig)) bySig.set(sig, id);
  }
  biomes = [...bySig.values()];
  const combos = combosFor(sp, egaCap);
  let best = null;
  for (const biome of biomes) {
    for (const combo of combos) {
      const r = computeAttraction(biome, combo).find((x) => x.dex === dex);
      if (!r || r.p <= 0) continue;
      const shiny = snackTotals(combo).shiny;
      const metric = 1 / (r.p * shiny); // ∝ snacks-to-shiny (baseRate is a constant scale)
      if (!best || metric < best.metric) best = { biome, combo, p: r.p, shiny, metric };
    }
  }
  return best;
}

function fmtCombo(combo) {
  if (!combo.length) return "no seasonings (plain snack)";
  const c = {};
  combo.forEach((b) => (c[b.id] = (c[b.id] || 0) + 1));
  return Object.entries(c).map(([id, n]) => `${n > 1 ? n + "× " : ""}${BERRY_BY_ID[id].name}`).join(" + ");
}

function planCard(title, plan, sp, baseRate) {
  if (!plan) return "";
  const eff = baseRate / plan.shiny;                 // effective 1-in-N per Pokémon at the provided base rate
  const targetOdds = eff / plan.p;
  const snacks = Math.max(1, Math.ceil(targetOdds / SNACK_BITES)); // expected snacks (avg)
  return `<div class="snack-plan">
    <h3>${title}</h3>
    <div class="plan-row"><span>Biome</span><b style="text-transform:capitalize">${isIngameBiome(plan.biome) ? biomeLabel(plan.biome) : plan.biome}</b></div>
    <div class="plan-row"><span>Snack</span><b>${fmtCombo(plan.combo)}</b></div>
    <div class="plan-row"><span>Spawn rate</span><b>${(plan.p * 100).toFixed(1)}%</b></div>
    <div class="plan-row"><span>Shiny odds</span><b>1/${Math.round(eff).toLocaleString()}</b> (✨×${plan.shiny})</div>
    <div class="plan-row"><span>Snacks to shiny</span><b>~${snacks.toLocaleString()}</b> <span class="muted">expected</span></div>
    ${spawnConditionsHtml(sp.dex, plan.biome)}
    <button class="ctrl-btn plan-apply" data-biome="${plan.biome}" data-combo="${plan.combo.map((b) => b.id).join(",")}" data-dex="${sp.dex}">Load into builder</button>
  </div>`;
}

function renderBestSnack(raw) {
  const sp = findSpecies(raw);
  if (!sp) { els.snackBestOut.innerHTML = `<p class="hint">No species matching "${raw}".</p>`; return; }
  const b0 = bestSnackFor(sp.dex, 0);
  if (!b0) {
    els.snackBestOut.innerHTML = `<p class="hint">${sp.name.replace(/-/g, " ")} has no natural Poké Snack spawn in base
      Cobblemon, so a snack can't lure it.</p>`;
    return;
  }
  const baseRate = Number(els.snackBaseRate.value) || state.config.baseShinyRate;
  const { tiers, note } = egaTiers(b0, bestSnackFor(sp.dex, 1), bestSnackFor(sp.dex, 3));
  els.snackBestOut.innerHTML =
    `<div class="find-row" style="border:0;padding:0 0 8px"><img src="${spriteUrl(sp.dex, true)}" alt=""/>
       <span class="find-name">Best plan · ${sp.name.replace(/-/g, " ")}</span></div>` +
    `<div class="snack-best-grid">` +
      tiers.map(([title, plan]) => planCard(title, plan, sp, baseRate)).join("") +
    `</div>${egaNoteText(note, sp.name.replace(/-/g, " "))}` +
    (SNACK_BLACKLIST.has(sp.dex) ? `<p class="hint">${SNACK_LURE_NOTE}</p>` : "") +
    `<p class="hint">Optimised for the fewest snacks to a <em>shiny of this species</em> (spawn rate × shiny boost).
      Base shiny rate ${baseRate} (edit it in "Snacks to a shiny"). "Load into builder" fills the controls above.</p>`;
}

// Apply a recommended plan to the manual builder so the full visitor list + estimate show.
function applySnackPlan(biome, ids, dex) {
  els.snackBiome.value = biome;
  // The optimiser assumes ideal placement (water included), so reflect that here.
  if (els.snackNearWater) els.snackNearWater.checked = true;
  ["snack-s0", "snack-s1", "snack-s2"].forEach((s, i) => { document.getElementById(s).value = ids[i] || ""; });
  snackTarget = String(dex);
  renderSnack();
  els.snackTarget.value = String(dex);
  renderSnackShiny(selectedSeasonings());
  els.snackBiome.scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ---------- spawn simulator tab ---------- */
/* Gate the structured Cobbleverse spawn pool by everything you can control at a
 * spot — biome, Y, vertical clearance (vs the mon's hitbox), placed/underfoot
 * blocks, time, weather and PokéSnack seasonings — then rank what survives by the
 * same bucket-odds × weight math the PokéSnack tab uses. */
let SIM = { spawns: {}, items: [], baseBlocks: [], hitbox: {} };
let SIM_LABEL = {};   // block key -> readable label (for condition annotations)
let simRanked = [];   // last simulated ranking (cached so target/rate tweaks are cheap)
let simTarget = "any";

const SIM_WATER_POS = new Set(["submerged", "seafloor", "fishing"]); // need water/fishing
const SIM_WATER_NEARBY = ["minecraft:water", "#minecraft:water", "minecraft:flowing_water"];
const TIME_ALIAS = { dawn: "dusk", dusk: "dusk", twilight: "dusk" };
const normTime = (t) => { t = String(t || "").toLowerCase(); return TIME_ALIAS[t] || t; };
const blockShort = (k) => SIM_LABEL[k] || k.replace(/^#/, "").replace(/^[a-z0-9_.-]+:/, "").replace(/_/g, " ");

function simSeasonings() {
  return ["sim-s0", "sim-s1", "sim-s2"].map((id) => document.getElementById(id).value)
    .filter(Boolean).map((id) => BERRY_BY_ID[id]).filter(Boolean);
}
function simPlacedItems() {
  const set = new Set();
  document.querySelectorAll("#sim-items input:checked").forEach((c) => set.add(c.value));
  return set;
}

// Which species can spawn at the described spot, ranked. Also returns a tally of
// why entries were rejected, so the UI can nudge ("3 too tall — dig higher").
function computeSpawns(o) {
  // No seasonings = natural world spawn (world weights); a placed snack uses the rarity-tier table.
  const snack = o.seasonings.length > 0;
  const odds = bucketOdds(o.seasonings.reduce((a, s) => a + (s.rarityTier || 0), 0), snack);
  const evReqs = evRequirements(o.seasonings);
  const buckets = { common: [], uncommon: [], rare: [], "ultra-rare": [] };
  const excl = { tall: 0, near: 0, base: 0, y: 0, time: 0, weather: 0, sky: 0, water: 0, light: 0 };
  const ow = isOverworldBiome(o.biome); // "any overworld" spawns count here too
  const snackCtx = o.seasonings.length > 0; // a snack is placed → lumymon blacklist applies
  for (const dex in SIM.spawns) {
    if (snackCtx && isSnackBlacklisted(dex)) continue;          // can't be snack-lured (off by default — we assume all lurable)
    const sp = DEX_BY_NUM[dex];
    const hb = SIM.hitbox[dex];
    for (const e of SIM.spawns[dex]) {
      if (!buckets[e.r] || !e.w) continue;
      const b = e.b || [];
      if (!b.includes(o.biome) && !b.includes("any biome") && !(ow && b.includes("any overworld"))) continue;
      if (!o.byWater && e.pos && SIM_WATER_POS.has(e.pos)) { excl.water++; continue; } // submerged/fishing need water
      if (o.openSky ? e.sky === false : e.sky === true) { excl.sky++; continue; }       // sky requirement vs the spot
      if (e.y && ((e.y[0] != null && o.y < e.y[0]) || (e.y[1] != null && o.y > e.y[1]))) { excl.y++; continue; }
      if (o.light != null && ((e.lt && (o.light < e.lt[0] || o.light > e.lt[1])) || (e.ml != null && o.light > e.ml))) { excl.light++; continue; }
      if (!o.openSky && hb && Math.ceil(hb[1]) > o.height) { excl.tall++; continue; } // Cobblemon needs ceil(hitbox) whole air blocks; open sky = unlimited
      if (e.near && !e.near.some((k) => o.items.has(k))) { excl.near++; continue; }
      if (e.base && !(o.baseBlock && e.base.includes(o.baseBlock))) { excl.base++; continue; }
      if (e.t && o.time !== "any" && normTime(e.t) !== o.time) { excl.time++; continue; }
      if (e.wx && o.weather !== "any" && !e.wx.includes(o.weather)) { excl.weather++; continue; }
      if (!passesEvGate(sp, evReqs)) continue;
      const mult = snackMult(sp, o.seasonings);
      const w = e.w * mult;
      if (w <= 0) continue;
      buckets[e.r].push({ dex: Number(dex), w, boosted: mult > 1 || evReqs.length > 0, e });
    }
  }
  // Raw bucket odds (no renormalising over present buckets) = true per-roll chance,
  // matching PokéNav; an empty bucket simply contributes a "nothing spawns" share.
  const present = BUCKETS.filter((b) => buckets[b].length);
  const at = {};
  for (const b of present) {
    const tot = buckets[b].reduce((a, x) => a + x.w, 0) || 1;
    const bp = odds[b];
    for (const x of buckets[b]) {
      const cur = at[x.dex] || (at[x.dex] = { p: 0, boosted: false, e: x.e });
      cur.p += bp * (x.w / tot);
      if (x.boosted) cur.boosted = true;
    }
  }
  const ranked = Object.entries(at).map(([dex, v]) => ({ dex: Number(dex), ...v })).sort((a, b) => b.p - a.p);
  return { ranked, excl };
}

// Conditions still attached to a surviving spawn — shown so you know what else to
// arrange (light/time/sky aren't gated by the controls, so they're informational).
function simCondNote(e, hb) {
  const bits = [];
  if (e.t) bits.push(`🕘 ${e.t}`);
  if (e.wx) bits.push(`🌧 ${e.wx.join("/")}`);
  if (e.sky === true) bits.push("☀️ open sky");
  if (e.sky === false) bits.push("⛰️ no sky");
  if (e.lt && (e.lt[0] > 0 || e.lt[1] < 15)) bits.push(`💡 light ${e.lt[0]}–${e.lt[1]}`);
  if (e.ml != null && e.ml < 15) bits.push(`💡 block light ≤${e.ml}`);
  if (e.pos) bits.push(`📐 ${e.pos}`);
  if (e.moon != null) bits.push(`🌙 moon ${e.moon}`);
  if (e.near) bits.push(`🧱 near ${e.near.map(blockShort).join("/")}`);
  if (e.base) bits.push(`▦ on ${e.base.map(blockShort).join("/")}`);
  if (hb) bits.push(`↥ ${hb[0]}×${hb[1]} hitbox`);
  return bits.join(" · ");
}

// Rebuild the shiny-target dropdown from the current ranking, keeping the pick.
function populateSimTargets(ranked) {
  if (!els.simTarget) return;
  const prev = simTarget;
  els.simTarget.innerHTML = `<option value="any">Any species (any shiny)</option>` +
    ranked.slice(0, 40).map((r) => {
      const sp = DEX_BY_NUM[r.dex];
      return `<option value="${r.dex}">${sp ? sp.name.replace(/-/g, " ") : "#" + r.dex} — ${(r.p * 100).toFixed(1)}%</option>`;
    }).join("");
  if (prev !== "any" && ranked.some((r) => String(r.dex) === String(prev))) els.simTarget.value = prev;
  else { simTarget = "any"; els.simTarget.value = "any"; }
}

// Snacks / spawns to a shiny, folding the target's spawn share into the odds.
function renderSimShiny() {
  if (!els.simShinyOut) return;
  if (!els.simBaseRate.value) els.simBaseRate.value = state.config.baseShinyRate;
  const baseRate = Number(els.simBaseRate.value) || state.config.baseShinyRate;
  const shiny = snackTotals(simSeasonings()).shiny;   // additive booster multiplier
  const effOdds = baseRate / shiny;                   // 1-in-N that any one spawn is shiny
  if (!simRanked.length) { els.simShinyOut.innerHTML = `<span class="muted">No spawns match — adjust the spot above.</span>`; return; }
  let p = 1, label = "Any shiny (whole spawn pool)";
  if (simTarget !== "any") {
    const r = simRanked.find((x) => String(x.dex) === String(simTarget));
    if (r) { p = r.p; const sp = DEX_BY_NUM[r.dex]; label = `${sp ? sp.name.replace(/-/g, " ") : "#" + r.dex} · ${(p * 100).toFixed(1)}% of spawns`; }
  }
  const targetOdds = effOdds / p;
  const snacks = (enc) => Math.max(1, Math.ceil(enc / SNACK_BITES));
  const rows = [
    ["Expected (avg)", Math.round(targetOdds)],
    ["50% chance", encountersForProb(0.5, targetOdds)],
    ["90% chance", encountersForProb(0.9, targetOdds)],
    ["99% chance", encountersForProb(0.99, targetOdds)],
  ];
  const shinyNote = shiny > 1 ? ` (base 1/${baseRate} × ✨×${shiny})` : "";
  els.simShinyOut.innerHTML =
    `Effective shiny odds <b>1/${Math.round(effOdds).toLocaleString()}</b> per spawn${shinyNote}<br>` +
    `<span class="muted">Target: ${label} → 1 shiny per <b>${Math.round(targetOdds).toLocaleString()}</b> spawns</span>` +
    `<table class="farm-tbl" style="margin-top:10px"><tr><th></th><th>Spawns</th><th>Snacks</th></tr>` +
    rows.map(([l, n]) => `<tr><td>${l}</td><td><b>${n.toLocaleString()}</b></td><td>${snacks(n).toLocaleString()}</td></tr>`).join("") +
    `</table>`;
}

function renderSim() {
  if (!els.simBiome) return;
  const openSky = els.simOpenSky.checked;
  const byWater = els.simWater.checked;
  els.simHeight.disabled = openSky;   // open sky = unlimited headroom, height has no effect
  const items = simPlacedItems();
  if (byWater) SIM_WATER_NEARBY.forEach((k) => items.add(k)); // by water => water counts as nearby
  const o = {
    biome: els.simBiome.value,
    y: Number(els.simY.value),
    height: Math.floor(Number(els.simHeight.value)) || 1,   // whole air blocks
    light: els.simLight.value === "" ? null : Number(els.simLight.value),
    time: els.simTime.value,
    weather: els.simWeather.value,
    baseBlock: els.simBase.value,
    openSky, byWater, items,
    seasonings: simSeasonings(),
  };
  const { ranked, excl } = computeSpawns(o);
  simRanked = ranked;
  populateSimTargets(ranked);
  renderSimShiny();

  const blocked = [];
  if (excl.water) blocked.push(`${excl.water} need water / fishing`);
  if (excl.sky) blocked.push(`${excl.sky} need ${openSky ? "cover (no sky)" : "open sky"}`);
  if (excl.light) blocked.push(`${excl.light} wrong light level`);
  if (excl.tall) blocked.push(`${excl.tall} too tall for ${o.height} block${o.height > 1 ? "s" : ""}`);
  if (excl.near) blocked.push(`${excl.near} need a block you haven't placed`);
  if (excl.y) blocked.push(`${excl.y} out of Y range`);
  if (excl.base) blocked.push(`${excl.base} need a specific spawn-area block`);
  if (excl.time) blocked.push(`${excl.time} wrong time`);
  if (excl.weather) blocked.push(`${excl.weather} wrong weather`);
  const space = openSky ? "open sky" : `<b>${o.height}</b> blocks of headroom`;
  els.simSummary.innerHTML = `<div class="card"><p class="hint" style="margin:0">
    <b>${ranked.length}</b> species can spawn at Y ${o.y} in <b style="text-transform:capitalize">${o.biome}</b>
    with ${space}${byWater ? ", by water" : ""}${o.items.size && !byWater ? ` and ${o.items.size} placed block${o.items.size > 1 ? "s" : ""}` : ""}.
    ${blocked.length ? `<br><span class="muted">Filtered out: ${blocked.join(" · ")}.</span>` : ""}</p></div>`;

  if (!ranked.length) {
    els.simResults.innerHTML = `<div class="card"><p class="hint">Nothing can spawn with these settings. Try more
      headroom, a different biome/Y, or placing the required block.</p></div>`;
    return;
  }
  const max = ranked[0].p || 1;
  const rows = ranked.slice(0, 40).map((r) => {
    const sp = DEX_BY_NUM[r.dex];
    const types = sp ? sp.types.map(typeChip).join(" ") : "";
    const note = simCondNote(r.e, SIM.hitbox[r.dex]);
    return `<div class="snack-row sim-row" data-dex="${r.dex}">
      <img loading="lazy" src="${spriteUrl(r.dex)}" alt="${sp ? sp.name : r.dex}" />
      <div class="snack-row-main">
        <div class="snack-row-name">${sp ? sp.name.replace(/-/g, " ") : "#" + r.dex} ${types}
          ${r.boosted ? '<span class="snack-boost">▲ lured</span>' : ""}</div>
        <div class="bar"><i style="width:${(r.p / max) * 100}%"></i></div>
        ${note ? `<div class="sim-cond">${note}</div>` : ""}
      </div>
      <div class="snack-pct">${(r.p * 100).toFixed(1)}%</div>
    </div>`;
  }).join("");
  const more = ranked.length > 40 ? `<p class="hint">…and ${ranked.length - 40} more rarer options.</p>` : "";
  els.simResults.innerHTML = `<div class="card snack-list">${rows}</div>${more}`;
}

function populateSimControls(biomeOpts, seasoningOpts) {
  els.simBiome.innerHTML = biomeOpts;
  els.simBase.innerHTML = `<option value="">— any / natural —</option>` +
    SIM.baseBlocks.map((b) => `<option value="${b.key}">${b.label}</option>`).join("");
  ["sim-s0", "sim-s1", "sim-s2"].forEach((id) => { document.getElementById(id).innerHTML = seasoningOpts; });
  SIM_LABEL = {};
  SIM.items.concat(SIM.baseBlocks).forEach((it) => (SIM_LABEL[it.key] = it.label));
  const groups = {};
  SIM.items.forEach((it) => (groups[it.group] = groups[it.group] || []).push(it));
  els.simItems.innerHTML = Object.keys(groups).sort().map((g) =>
    `<div class="sim-item-group"><div class="sim-item-group-h">${g}</div><div class="sim-item-row">` +
    groups[g].map((it) => `<label class="sim-item"><input type="checkbox" value="${it.key}"/> ${it.label}</label>`).join("") +
    `</div></div>`).join("");
}

/* ---------- spawn optimizer (pick the best spot + snack for a target) ---------- */
let simBestPlans = [];   // one entry per shown EGA tier, indexed by the card's data-plan

// Candidate (entry, concrete-biome) pairs the target can spawn in — wildcards expand.
function simEntriesFor(dex) {
  const out = [];
  for (const e of SIM.spawns[dex] || []) {
    const bs = e.b || [];
    let biomes;
    if (bs.includes("any biome")) biomes = Object.keys(BIOME_INDEX);
    else {
      biomes = bs.filter((b) => BIOME_INDEX[b]);
      if (bs.includes("any overworld")) biomes = biomes.concat(Object.keys(BIOME_INDEX).filter(isOverworldBiome));
    }
    [...new Set(biomes)].forEach((b) => out.push({ e, biome: b }));
  }
  return out;
}

// Concrete spot variants that satisfy an entry, trying the exclusionary edges of
// its Y/light windows (a tight value dodges competitors that need other values).
function buildSpots(e, biome, hb) {
  const ys = e.y
    ? [...new Set([e.y[0], e.y[1], Math.round(((e.y[0] != null ? e.y[0] : -64) + (e.y[1] != null ? e.y[1] : 320)) / 2)].filter((v) => v != null))]
    : [63];
  const lLo = e.lt ? e.lt[0] : 0;
  const lHi = Math.min(e.lt ? e.lt[1] : 15, e.ml != null ? e.ml : 15);
  const lights = [...new Set([lLo, lHi])];
  // sky:true -> must be open; sky:false -> must be covered; unconstrained -> try
  // both, since a tight covered ceiling can exclude all taller competitors.
  const skyOpts = e.sky === true ? [true] : e.sky === false ? [false] : [true, false];
  // Restricting time only removes competitors, so for a time-unconstrained mon
  // "any" is always dominated — try day/night to dodge time-locked competitors.
  const times = e.t ? [normTime(e.t)] : ["day", "night"];
  const byWater = !!(e.pos && SIM_WATER_POS.has(e.pos));
  const place = e.near ? [e.near[0]] : [];
  const baseBlock = e.base ? e.base[0] : "";
  const weather = e.wx ? e.wx[0] : "any";
  const spots = [];
  for (const openSky of skyOpts) {
    const height = openSky ? 20 : Math.max(1, Math.ceil(hb ? hb[1] : 1)); // tight ceiling dodges taller mons
    for (const time of times) for (const y of ys) for (const light of lights) {
      spots.push({ biome, y, light, height, openSky, byWater, place, baseBlock, time, weather });
    }
  }
  return spots;
}

// Target's spawn share at a spot with the given seasonings.
function simSpotP(dex, spot, seasonings) {
  const items = new Set(spot.place);
  if (spot.byWater) SIM_WATER_NEARBY.forEach((k) => items.add(k));
  const o = { biome: spot.biome, y: spot.y, height: spot.height, light: spot.light, time: spot.time,
    weather: spot.weather, baseBlock: spot.baseBlock, openSky: spot.openSky, byWater: spot.byWater, items, seasonings };
  const r = computeSpawns(o).ranked.find((x) => x.dex === dex);
  return r ? r.p : 0;
}

// Search spot conditions (phase 1) then seasonings on the best spots (phase 2) for
// the lowest snacks-to-shiny = max spawn-share × shiny multiplier.
function optimizeSpawn(dex, egaCap) {
  const sp = DEX_BY_NUM[dex];
  if (!sp || !SIM.spawns[dex]) return null;
  const hb = SIM.hitbox[dex];
  let spots = [];
  for (const { e, biome } of simEntriesFor(dex)) spots = spots.concat(buildSpots(e, biome, hb));
  const seen = new Set();
  spots = spots.filter((s) => { const k = JSON.stringify(s); if (seen.has(k)) return false; seen.add(k); return true; });
  // Snack-blacklisted mons (lumymon) can't be lured, so optimise the natural spot
  // with NO seasonings; otherwise rank spots WITH the pool-shaping gate so a spot
  // that's only good once competitors are gated out isn't pruned before phase 2.
  const blacklisted = isSnackBlacklisted(dex);
  const gate = blacklisted ? [] : gateSeasonings(sp);
  spots.forEach((s) => (s.p0 = simSpotP(dex, s, gate)));
  const top = spots.filter((s) => s.p0 > 0).sort((a, b) => b.p0 - a.p0).slice(0, 12);
  if (!top.length) return null;
  const combos = blacklisted ? [[]] : combosFor(sp, egaCap);
  let best = null;
  for (const s of top) for (const combo of combos) {
    const p = simSpotP(dex, s, combo);
    if (!p) continue;
    const shiny = snackTotals(combo).shiny;
    const metric = 1 / (p * shiny);
    if (!best || metric < best.metric) best = { spot: s, combo, p, shiny, metric };
  }
  return best;
}

function describeSimSpot(s) {
  const bits = [
    `<div class="plan-row"><span>Biome</span><b style="text-transform:capitalize">${s.biome}</b></div>`,
    `<div class="plan-row"><span>Y level</span><b>${s.y}</b></div>`,
    `<div class="plan-row"><span>Light level</span><b>${s.light}</b></div>`,
    `<div class="plan-row"><span>Sky</span><b>${s.openSky ? "open sky" : `covered, ${s.height}-block ceiling`}</b></div>`,
  ];
  if (s.byWater) bits.push(`<div class="plan-row"><span>Water</span><b>by water / fishing</b></div>`);
  if (s.place.length) bits.push(`<div class="plan-row"><span>Place nearby</span><b>${s.place.map(blockShort).join(", ")}</b></div>`);
  if (s.baseBlock) bits.push(`<div class="plan-row"><span>Stand on</span><b>${blockShort(s.baseBlock)}</b></div>`);
  if (s.time !== "any") bits.push(`<div class="plan-row"><span>Time</span><b>${s.time}</b></div>`);
  if (s.weather !== "any") bits.push(`<div class="plan-row"><span>Weather</span><b>${s.weather}</b></div>`);
  return bits.join("");
}

function simPlanCard(title, plan, idx, baseRate) {
  if (!plan) return "";
  const eff = baseRate / plan.shiny;
  const snacks = Math.max(1, Math.ceil((eff / plan.p) / SNACK_BITES));
  return `<div class="snack-plan">
    <h3>${title}</h3>
    ${describeSimSpot(plan.spot)}
    <div class="plan-row"><span>Snack</span><b>${fmtCombo(plan.combo)}</b></div>
    <div class="plan-row"><span>Spawn chance</span><b>${(plan.p * 100).toFixed(1)}%</b></div>
    <div class="plan-row"><span>Shiny odds</span><b>1/${Math.round(eff).toLocaleString()}</b> (✨×${plan.shiny})</div>
    <div class="plan-row"><span>Snacks to shiny</span><b>~${snacks.toLocaleString()}</b> <span class="muted">expected</span></div>
    <button class="ctrl-btn good sim-plan-apply" data-plan="${idx}">Load into simulator below</button>
  </div>`;
}

function renderSimBest(raw) {
  const sp = findSpecies(raw);
  if (!sp) { els.simBestOut.innerHTML = `<p class="hint">No species matching "${raw}".</p>`; return; }
  const b0 = optimizeSpawn(sp.dex, 0);   // no EGA
  if (!b0) {
    els.simBestOut.innerHTML = `<p class="hint">${sp.name.replace(/-/g, " ")} has no simulatable wild spawn in the
      Cobbleverse data (event / evolution / trade only), so there's no spot to optimize.</p>`;
    return;
  }
  const blacklisted = isSnackBlacklisted(sp.dex);
  // Blacklisted mons can't be lured, so all EGA tiers are identical (no snack).
  const { tiers, note } = blacklisted ? { tiers: [["Natural spot (no snack)", b0]], note: "" }
    : egaTiers(b0, optimizeSpawn(sp.dex, 1), optimizeSpawn(sp.dex, 3));
  tiers.forEach(([, plan]) => { if (plan) plan.targetDex = sp.dex; });
  simBestPlans = tiers.map(([, plan]) => plan);
  if (!els.simBaseRate.value) els.simBaseRate.value = state.config.baseShinyRate;
  const baseRate = Number(els.simBaseRate.value) || state.config.baseShinyRate;
  const blacklistNote = blacklisted
    ? `<p class="hint">⛔ ${sp.name.replace(/-/g, " ")} is <b>blacklisted from Poké Snacks</b> (Cobbleverse lumymon config), so seasonings can't lure it — this is the best <em>natural</em> spot.</p>`
    : (SNACK_BLACKLIST.has(sp.dex) ? `<p class="hint">${SNACK_LURE_NOTE}</p>` : "");
  els.simBestOut.innerHTML =
    `<div class="find-row" style="border:0;padding:0 0 8px"><img src="${spriteUrl(sp.dex, true)}" alt=""/>
       <span class="find-name">Best spot · ${sp.name.replace(/-/g, " ")}</span></div>` +
    `<div class="snack-best-grid">` +
      tiers.map(([title, plan], i) => simPlanCard(title, plan, i, baseRate)).join("") +
    `</div>${blacklistNote}${egaNoteText(note, sp.name.replace(/-/g, " "))}` +
    `<p class="hint">Spawn chance = this mon's per-roll chance at that spot (bucket odds × in-bucket weight), matching PokéNav.
      "Load into simulator" fills the controls so you can see the full visitor list.</p>`;
}

function applySimPlan(plan) {
  const s = plan.spot;
  els.simBiome.value = s.biome;
  els.simY.value = s.y;
  els.simLight.value = s.light;
  els.simHeight.value = s.height;
  els.simOpenSky.checked = s.openSky;
  els.simWater.checked = s.byWater;
  els.simBase.value = s.baseBlock;
  els.simTime.value = s.time;
  els.simWeather.value = s.weather;
  // tick exactly the blocks the plan places (water is handled by the by-water box)
  document.querySelectorAll("#sim-items input").forEach((c) => (c.checked = s.place.includes(c.value)));
  const ids = plan.combo.map((b) => b.id);
  ["sim-s0", "sim-s1", "sim-s2"].forEach((id, i) => { document.getElementById(id).value = ids[i] || ""; });
  simTarget = String(plan.targetDex || "any");   // preserved by populateSimTargets if present
  renderSim();
  if (els.simTarget.querySelector(`option[value="${plan.targetDex}"]`)) { els.simTarget.value = String(plan.targetDex); renderSimShiny(); }
  els.simBiome.scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ---------- seed map: live seed → structure coordinates (Chunkbase-style) ---------- */
// Java's Random LCG, exact (validated against the canonical new Random(0) sequence).
const JR_MULT = 0x5DEECE66Dn, JR_ADD = 0xBn, JR_MASK = (1n << 48n) - 1n;
class JRandom {
  constructor(seed) { this.setSeed(seed); }
  setSeed(seed) { this.seed = (BigInt.asUintN(64, BigInt(seed)) ^ JR_MULT) & JR_MASK; }
  next(bits) { this.seed = (this.seed * JR_MULT + JR_ADD) & JR_MASK; return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits))); }
  nextInt(bound) {
    if (bound === undefined) return this.next(32); // Java Random.nextInt() — full signed int
    if (bound <= 0) return 0;
    if ((bound & -bound) === bound) return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n);
    let bits, val;
    do { bits = this.next(31); val = bits % bound; } while (bits - val + (bound - 1) < 0);
    return val;
  }
}
// World seed: a number string is taken literally (64-bit); anything else uses
// Java's String.hashCode, exactly like Minecraft.
function seedToLong(s) {
  s = String(s == null ? "" : s).trim();
  if (s === "") return 0n;
  if (/^-?\d+$/.test(s)) return BigInt.asIntN(64, BigInt(s));
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return BigInt(h);
}
function smRegionSeed(seed, rx, rz, salt) {
  return BigInt.asIntN(64, BigInt(rx) * 341873128712n + BigInt(rz) * 132897987541n + seed + BigInt(salt));
}
// The candidate chunk a structure_set tries to place in one region (rx,rz).
function smCandidateChunk(seed, rx, rz, st) {
  const d = st.spacing - st.separation;
  const rng = new JRandom(smRegionSeed(seed, rx, rz, st.salt));
  let ox, oz;
  if (st.spread === "triangular") {
    ox = Math.floor((rng.nextInt(d) + rng.nextInt(d)) / 2);
    oz = Math.floor((rng.nextInt(d) + rng.nextInt(d)) / 2);
  } else { ox = rng.nextInt(d); oz = rng.nextInt(d); }
  return [rx * st.spacing + ox, rz * st.spacing + oz];
}
// Index for exclusion-zone lookups (other_set id -> structure). Built in loadStructures.
let STRUCT_BY_ID = new Map();
// Is (chx,chz) the candidate chunk its region picks? (MC isPlacementChunk)
function smIsPlacementChunk(seed, st, chx, chz) {
  const rx = Math.floor(chx / st.spacing), rz = Math.floor(chz / st.spacing);
  const ch = smCandidateChunk(seed, rx, rz, st);
  return ch[0] === chx && ch[1] === chz;
}
// The placement rules applied on TOP of the grid (MC isStructureChunk, minus the
// already-checked isPlacementChunk): the frequency reducer + the exclusion zone.
// Without these the map over-shows candidates that the server won't actually generate.
// Bit-exact with 1.21.1 StructurePlacement (decompiled): freq<1 cobbleverse sets all
// use the legacy_type_3 (pillager-outpost) reducer.
function smPlacementPasses(seed, st, chx, chz) {
  if (st.freq != null && st.freq < 1) {
    // legacy_type_3: seed = (long)(i ^ (j<<4)) ^ worldSeed; discard one int; keep iff nextInt(1/freq)==0.
    // (int)(1/0.75)=1 -> nextInt(1) is always 0, so freq 0.75 + legacy_type_3 never thins — a real MC quirk.
    const i = chx >> 4, j = chz >> 4;
    const r = new JRandom(BigInt.asIntN(64, BigInt(i ^ (j << 4))) ^ seed);
    r.nextInt(); // discarded
    if (r.nextInt(Math.floor(1 / st.freq)) !== 0) return false;
  }
  if (st.exclude) {
    const other = STRUCT_BY_ID.get(st.exclude.set);
    if (other) {
      const c = st.exclude.chunks;
      for (let dx = chx - c; dx <= chx + c; dx++)
        for (let dz = chz - c; dz <= chz + c; dz++)
          if (smIsStructureChunk(seed, other, dx, dz)) return false; // forbidden near other_set
    }
  }
  return true;
}
function smIsStructureChunk(seed, st, chx, chz) {
  return smIsPlacementChunk(seed, st, chx, chz) && smPlacementPasses(seed, st, chx, chz);
}
function smStructValid(st) {
  return st && st.spacing > 0 && st.separation != null && st.separation >= 0
    && st.separation < st.spacing && st.salt != null && st.salt !== "";
}
// All candidate block positions for a structure_set within `radius` of (cx,cz).
function smFindCandidates(seed, st, cx, cz, radius) {
  const ccx = Math.floor(cx / 16), ccz = Math.floor(cz / 16);
  const rChunks = Math.ceil(radius / 16);
  const cReg = Math.floor(ccx / st.spacing), cRegZ = Math.floor(ccz / st.spacing);
  const rr = Math.ceil(rChunks / st.spacing) + 1;
  const out = [];
  for (let rx = cReg - rr; rx <= cReg + rr; rx++) {
    for (let rz = cRegZ - rr; rz <= cRegZ + rr; rz++) {
      const [chx, chz] = smCandidateChunk(seed, rx, rz, st);
      if (!smPlacementPasses(seed, st, chx, chz)) continue; // frequency/exclusion-zone gate
      const bx = chx * 16 + 8, bz = chz * 16 + 8;
      const dist = Math.round(Math.hypot(bx - cx, bz - cz));
      if (dist <= radius) out.push({ x: bx, z: bz, dist });
    }
  }
  out.sort((a, b) => a.dist - b.dist);
  return out;
}
// Prefilled from decompiling Cobbleverse (spacing known; separation/salt must come
// from the datapack — paste the structure_set JSON to load them exactly).
const SM_PACK_COLORS = { cobbleverse: "#4fd1c5", legendarymonuments: "#f6c544", lumymon: "#c084fc" };
function smPackColor(p) { return SM_PACK_COLORS[p] || "#8ab4ff"; }
function seedMapCfg() {
  let m = state.config.seedMap;
  if (!m || typeof m !== "object") m = state.config.seedMap = {};
  delete m.structures; // legacy editable list removed — structures are bundled now
  if (typeof m.seed !== "string") m.seed = "";
  if (!Number.isFinite(m.cx)) m.cx = 0;
  if (!Number.isFinite(m.cz)) m.cz = 0;
  if (!Number.isFinite(m.radius)) m.radius = 5000;
  return m;
}
let smLastResults = null; // cached for canvas redraw
function renderSeedMap() {
  const m = seedMapCfg();
  if (els.smSeed) els.smSeed.value = m.seed;
  if (els.smCx) els.smCx.value = m.cx;
  if (els.smCz) els.smCz.value = m.cz;
  if (els.smRadius) els.smRadius.value = m.radius;
}
function computeSeedMap() {
  if (!STRUCTURES) { loadStructures().then(computeSeedMap); return; } // bundled structures
  const m = seedMapCfg();
  m.seed = els.smSeed.value;
  m.cx = Math.round(Number(els.smCx.value) || 0);
  m.cz = Math.round(Number(els.smCz.value) || 0);
  m.radius = Math.max(100, Math.round(Number(els.smRadius.value) || 5000));
  save();
  const seed = seedToLong(m.seed);
  const results = STRUCTURES.filter((st) => (st.dim || "overworld") === biomeState.dim)
    .map((st) => ({ st, cands: smFindCandidates(seed, st, m.cx, m.cz, m.radius) }))
    .filter((r) => r.cands.length)
    .sort((a, b) => a.cands[0].dist - b.cands[0].dist);
  smLastResults = { results, m };
  renderSeedMapResults();
  sampleCandidateBiomes(results); // async: tag each candidate on/off-biome, then re-filter
}
// Ask the worker for the real (surface-height) biome at each candidate so the
// "Nearest candidates" list can drop off-biome slots — works without a server probe.
let smSampleSeq = 0, smSamplePending = null;
function sampleCandidateBiomes(results) {
  const w = getBiomeWorker();
  if (!w) return;
  // Sample biomes nearest-first PER STRUCTURE (r.cands is distance-sorted). A single
  // global cap let the dense small-spacing structures at the END of the rarest-first list
  // (gyms, leagues, shrines — ~29 of them past slot 4000) go entirely unsampled, so they
  // showed every placement slot as if on-biome. A per-structure budget guarantees each one
  // validates its nearest candidates. We only display ~6 per structure, so 96 nearest is
  // ample margin even for sparse-biome (e.g. ocean-temperature) structures.
  const PER_CAP = 96, GLOBAL_CAP = 16000, pts = [], cave = [], refs = [];
  const probe = (structureProbe && structureProbe.dim === biomeState.dim) ? structureProbe : null;
  for (const r of results) {
    const under = structUnderground(r.st);
    const judgeable = r.st.biomes && r.st.biomes.length;
    let checked = 0; // deepslate samples spent on THIS structure (probe hits don't count)
    for (const c of r.cands) {
      if (!judgeable) { c.match = null; continue; }
      // A loaded probe is the authoritative (real server) surface biome — use it directly.
      if (probe && !under) {
        const p = probe.byKey.get(c.x + "," + c.z);
        if (p != null) { c.biome = p; c.match = r.st.biomes.indexOf(p) >= 0; c.authoritative = true; continue; }
      }
      if (checked >= PER_CAP || pts.length >= GLOBAL_CAP) { c.match = null; continue; }
      c.match = null; // pending until the worker answers
      pts.push([c.x, c.z]); cave.push(under); refs.push({ c, st: r.st }); checked++;
    }
  }
  renderSeedMapResults(); // apply any probe-confirmed matches immediately
  if (!pts.length) return;
  const id = ++smSampleSeq;
  smSamplePending = { id, refs };
  w.postMessage({ type: "samplePoints", id, seed: els.smSeed.value, dim: biomeState.dim, pts, cave });
}
function onCandidateBiomes(m) {
  if (!smSamplePending || smSamplePending.id !== m.id || !m.biomes) return;
  const refs = smSamplePending.refs;
  smSamplePending = null;
  for (let i = 0; i < refs.length; i++) {
    const { c, st } = refs[i], b = m.biomes[i];
    c.biome = b;
    c.match = (b == null) ? null : st.biomes.indexOf(b) >= 0;
    c.authoritative = false; // deepslate estimate — advisory only, never hide on it
  }
  renderSeedMapResults();
}
function smCopyFlash(btn) { const o = btn.textContent; btn.textContent = "✓"; setTimeout(() => (btn.textContent = o), 900); }
const SM_DIM_LABEL = { nether: "🔥 Nether", end: "🟣 End" };
function renderSeedMapResults() {
  if (!smLastResults) return;
  const { results, m } = smLastResults;
  const card = document.getElementById("sm-out-card");
  const out = document.getElementById("sm-results");
  const status = document.getElementById("sm-status");
  if (card) card.hidden = false;
  if (!results.length) {
    if (status) status.textContent = `seed ${seedToLong(m.seed)} · 0 structures within ${m.radius.toLocaleString()} blocks of (${m.cx}, ${m.cz})`;
    out.innerHTML = `<p class="hint">No structures within ${m.radius.toLocaleString()} blocks — try a larger radius.</p>`; drawSeedMapCanvas(); return;
  }
  const showOff = !!(els.smBiomeMatch && els.smBiomeMatch.checked);
  // HIDE off-biome candidates on the deepslate estimate (user's choice — cleaner list).
  // deepslate isn't bit-exact near spawn, so this can occasionally hide a real slot or keep a
  // phantom; a loaded /locate probe overrides with bit-exact positions (✅ verified). "Show
  // off-biome" keeps every slot. null match (pending/unjudgeable) is kept.
  const locD = locatedStructures[biomeState.dim] || null;
  const shown = results
    .map((r) => {
      const loc = locD && locD.get(r.st.id);
      if (loc && loc.length) { // bit-exact /locate positions override the deepslate guess
        const cands = loc.map((p) => ({ x: p.x, z: p.z, dist: p.dist != null ? p.dist : Math.round(Math.hypot(p.x - m.cx, p.z - m.cz)) }))
          .sort((a, b) => a.dist - b.dist);
        return { r, cands, verified: true, hidden: 0 };
      }
      const cands = showOff ? r.cands : r.cands.filter((c) => c.match !== false);
      return { r, cands, verified: false, hidden: r.cands.length - cands.length };
    })
    .filter((x) => x.cands.length > 0);
  if (status) status.textContent = `seed ${seedToLong(m.seed)} · ${shown.length}${shown.length < results.length ? " of " + results.length : ""} structure${shown.length === 1 ? "" : "s"} within ${m.radius.toLocaleString()} blocks of (${m.cx}, ${m.cz})`;
  if (!shown.length) {
    out.innerHTML = `<p class="hint">All ${results.length} structure${results.length === 1 ? "" : "s"} in range are off-biome — try a larger radius${showOff ? "" : " or enable “Show off-biome”"}.</p>`;
    drawSeedMapCanvas(); return;
  }
  out.innerHTML = shown.map(({ r, cands, verified, hidden }) => {
    const col = smPackColor(r.st.pack);
    const dim = SM_DIM_LABEL[r.st.dim] ? ` · ${SM_DIM_LABEL[r.st.dim]}` : "";
    const rows = cands.slice(0, 6).map((c) => {
      return `<div class="sm-cand"><span class="sm-coord">X <b>${c.x}</b>, Z <b>${c.z}</b></span>` +
      `<span class="muted">${c.dist.toLocaleString()} blocks</span>` +
      `<button class="ctrl-btn ghost sm-copy" data-xz="${c.x} ${c.z}" title="Copy coordinates">copy</button>` +
      `<button class="ctrl-btn ghost sm-copy" data-xz="/tp @s ${c.x} ~ ${c.z}" title="Copy /tp command">/tp</button>` +
      (r.st.id ? `<button class="ctrl-btn ghost sm-copy" data-xz="/execute positioned ${c.x} 64 ${c.z} run locate structure ${r.st.id}" title="Copy a /locate that searches from this spot — run it in-game; if it returns these coords, the structure is confirmed here">/locate</button>` : "") +
      `</div>`;
    }).join("");
    const locateBtn = r.st.id
      ? `<button class="ctrl-btn ghost sm-copy" data-xz="/execute positioned ${m.cx} 64 ${m.cz} run locate structure ${r.st.id}" title="Copy a /locate that finds the nearest one to the scan center (${m.cx}, ${m.cz}) — the game's authoritative answer">📍 /locate</button>`
      : "";
    const caveNote = (structUnderground(r.st) && !verified)
      ? `<span class="muted" title="This structure's biome (${r.st.biomes.join(", ")}) only exists underground, so the biome map can't tell which slots are real. The coords below are raw placement slots — use /locate to find the actual one.">⛏ underground biome · coords are slots, use /locate</span>`
      : "";
    const offNote = verified ? "" : (hidden > 0 ? ` · ${hidden} off-biome hidden` : "");
    const verifiedBadge = verified ? ` <span style="color:#4ade80;font-size:.8em" title="Bit-exact positions from the server's own /locate (via RCON) — no deepslate guessing">✅ verified</span>` : "";
    return `<div class="sm-res"><div class="sm-res-h"><span class="sm-dot" style="background:${col}"></span>` +
      `<b>${r.st.icon || ""} ${r.st.name}</b>${r.st.target ? ` <span class="muted">→ ${r.st.target}</span>` : ""}${verifiedBadge}` +
      `<span class="muted">${dim} · nearest ${Math.min(6, cands.length)} of ${cands.length}${offNote}</span>${locateBtn}${caveNote}</div>${rows}</div>`;
  }).join("");
  drawSeedMapCanvas();
}
function drawSeedMapCanvas() {
  const cv = document.getElementById("sm-canvas");
  if (!cv || !smLastResults) return;
  const { results, m } = smLastResults;
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height, cxp = W / 2, czp = H / 2, R = m.radius;
  ctx.fillStyle = "#0b1322"; ctx.fillRect(0, 0, W, H);
  // radius circle + crosshair
  ctx.strokeStyle = "#243549"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cxp, czp, (W / 2) - 6, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cxp, 6); ctx.lineTo(cxp, H - 6); ctx.moveTo(6, czp); ctx.lineTo(W - 6, czp); ctx.stroke();
  const scale = ((W / 2) - 6) / R;
  for (const r of results) {
    if (!r.cands || !r.cands.length) continue;
    ctx.fillStyle = smPackColor(r.st.pack);
    for (const c of r.cands.slice(0, 8)) {
      const px = cxp + (c.x - m.cx) * scale, py = czp + (c.z - m.cz) * scale;
      ctx.beginPath(); ctx.arc(px, py, c === r.cands[0] ? 5 : 3, 0, Math.PI * 2); ctx.fill();
    }
  }
  // center marker
  ctx.fillStyle = "#e7eef7"; ctx.beginPath(); ctx.arc(cxp, czp, 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#93a4b8"; ctx.font = "12px system-ui, sans-serif"; ctx.textAlign = "left";
  ctx.fillText(`±${R.toLocaleString()} blocks`, 8, H - 8);
}
/* ---------- biome map (deepslate Terralith, in a worker) ---------- */
let biomeWorker = null;
let biomeState = { dim: "overworld", cx: 0, cz: 0, bpp: 2, cols: 192, rows: 192, img: null, grid: null, palette: null, legend: null, busy: false, rendered: false };
const DIM_BG = { overworld: "#0b1322", nether: "#1a0f0c", end: "#0e0a18" };
let biomeRerender = false, biomeRenderTimer = null;
const BIOME_ZOOM_STEPS = [1, 2, 4, 8, 16];
// Authoritative legendary/Cobbleverse structures (real datapack params) — always
// overlaid on the biome map as icons, regardless of the seed-map finder.
let STRUCTURES = null, biomeIconHits = [];
function loadStructures() {
  if (STRUCTURES) return Promise.resolve();
  return fetch("js/data/worldgen/structures.json").then((r) => r.json())
    .then((s) => { STRUCTURES = s; STRUCT_BY_ID = new Map(s.map((x) => [x.id, x])); if (biomeState.img) drawBiomeCanvas(0, 0); })
    .catch(() => (STRUCTURES = []));
}
let BIOME_COLORS = null;
function loadBiomeColors() {
  if (BIOME_COLORS) return Promise.resolve();
  return fetch("js/data/worldgen/biome_colors.json").then((r) => r.json()).then((c) => (BIOME_COLORS = c)).catch(() => (BIOME_COLORS = {}));
}
const DUMP_DIM = { "minecraft:overworld": "overworld", "minecraft:the_nether": "nether", "minecraft:the_end": "end" };
// Load a biome-dump JSON from the Biome Dump server mod — the server's REAL
// biomes. Renders it as the backdrop and (crucially) makes structure biome
// validation accurate, since the grid is exactly what the world generates.
function loadBiomeExport(json) {
  if (!json || !Array.isArray(json.grid) || !Array.isArray(json.palette)) { els.smBiomeStatus.textContent = "⚠ not a biome-dump file"; return; }
  loadBiomeRemap(); loadStructures(); loadBiomeSpawns();
  loadBiomeColors().then(() => {
    const dim = DUMP_DIM[json.dimension] || "overworld";
    biomeState.dim = dim;
    biomeState.cx = json.centerX | 0; biomeState.cz = json.centerZ | 0;
    biomeState.bpp = json.step; biomeState.cols = json.cols; biomeState.rows = json.rows;
    biomeState.palette = json.palette;
    biomeState.grid = Uint16Array.from(json.grid);
    biomeState.fromExport = true; biomeState.rendered = true;
    const cache = {};
    const col = (id) => { if (cache[id]) return cache[id]; const hex = BIOME_COLORS[id] || "#3a4a5a"; const n = parseInt(hex.slice(1), 16); return cache[id] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    const rgba = new Uint8ClampedArray(json.cols * json.rows * 4);
    for (let k = 0; k < json.grid.length; k++) { const [r, g, b] = col(json.palette[json.grid[k]]); const o = k * 4; rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255; }
    biomeState.img = new ImageData(rgba, json.cols, json.rows);
    const uniq = {}; for (const id of new Set(json.palette)) uniq[id] = BIOME_COLORS[id] || "#3a4a5a";
    biomeState.legend = Object.entries(uniq).map(([id, hex]) => ({ id, hex }));
    document.querySelectorAll("#sm-dim .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.dim === dim));
    els.smCx.value = biomeState.cx; els.smCz.value = biomeState.cz;
    drawBiomeCanvas(0, 0); renderBiomeLegend(biomeState.legend);
    els.smBiomeStatus.textContent = `✓ real biomes (server export) · ${json.cols * json.step}×${json.rows * json.step} blocks · ${biomeState.legend.length} biomes`;
  });
}
// Authoritative biome at structure candidates, from the /probestructures mod
// command: { dim, seed, byKey: Map "x,z" -> "biome:id" }. Used to mark candidates
// valid/dim from the server's REAL biomes (deepslate stays the visual backdrop).
let structureProbe = null;
function loadStructureProbe(json) {
  if (!json || !json.points || typeof json.points !== "object") { els.smBiomeStatus.textContent = "⚠ not a probe file (run /probestructures in the mod)"; return; }
  const dim = DUMP_DIM[json.dimension] || "overworld";
  const byKey = new Map(Object.entries(json.points));
  structureProbe = { dim, seed: json.seed, byKey };
  // The probe coords were computed from the server seed; warn if the map's seed differs.
  let warn = "";
  if (json.seed != null && els.smSeed && String(seedToLong(els.smSeed.value)) !== String(json.seed)) {
    els.smSeed.value = String(json.seed); // align so candidate coords match the probe
    seedMapCfg().seed = els.smSeed.value; save();
    warn = " · seed set to " + json.seed;
  }
  document.querySelectorAll("#sm-dim .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.dim === dim));
  biomeState.dim = dim;
  if (biomeState.rendered) drawBiomeCanvas(0, 0);
  renderSeedMapResults(); // list now filters off-biome candidates authoritatively
  els.smBiomeStatus.textContent = `🎯 probe loaded · ${byKey.size} candidate biomes (${dim})${warn} · markers now server-accurate`;
}
// Bit-exact structure positions from vanilla /locate over RCON (tools/locate-rcon).
// { dim, byId: Map id -> [{x,z,dist?}] }. When loaded, the seed-map list shows these
// authoritative positions instead of the deepslate-filtered candidates.
let locatedStructures = {}; // dim -> Map(id -> [{x,z,dist?}]); load overworld/nether/end independently
function loadLocatedStructures(json) {
  if (!json || !json.located || typeof json.located !== "object") { els.smBiomeStatus.textContent = "⚠ not a located-structures file (run tools/locate-rcon)"; return; }
  const dim = DUMP_DIM[json.dimension] || "overworld";
  const byId = new Map();
  for (const [id, v] of Object.entries(json.located)) {
    if (Array.isArray(v)) byId.set(id, v.filter((p) => Array.isArray(p)).map(([x, z]) => ({ x, z })));
    else if (v && typeof v.x === "number") byId.set(id, [{ x: v.x, z: v.z, dist: v.dist }]);
  }
  locatedStructures[dim] = byId;
  renderSeedMapResults();
  els.smBiomeStatus.textContent = `📡 ${byId.size} structures located (${dim}) — exact /locate positions`;
}
// Candidate block positions of a structure_set within a view box (reuses the
// validated random_spread placement from the seed-map engine).
function structuresInView(seed, st, minX, maxX, minZ, maxZ) {
  const sp = st.spacing, out = [];
  const rMinX = Math.floor(Math.floor(minX / 16) / sp) - 1, rMaxX = Math.floor(Math.floor(maxX / 16) / sp) + 1;
  const rMinZ = Math.floor(Math.floor(minZ / 16) / sp) - 1, rMaxZ = Math.floor(Math.floor(maxZ / 16) / sp) + 1;
  for (let rx = rMinX; rx <= rMaxX; rx++) {
    for (let rz = rMinZ; rz <= rMaxZ; rz++) {
      const ch = smCandidateChunk(seed, rx, rz, st);
      if (!smPlacementPasses(seed, st, ch[0], ch[1])) continue; // frequency/exclusion-zone gate
      const bx = ch[0] * 16 + 8, bz = ch[1] * 16 + 8;
      if (bx >= minX && bx <= maxX && bz >= minZ && bz <= maxZ) out.push({ x: bx, z: bz });
    }
  }
  return out;
}
let BIOME_REMAP = null; // loaded lazily for hover labels (worker applies its own copy)
function loadBiomeRemap() {
  if (BIOME_REMAP) return;
  fetch("js/data/worldgen/biome_replacer.json").then((r) => r.json()).then((m) => (BIOME_REMAP = m)).catch(() => (BIOME_REMAP = {}));
}
function scheduleBiomeRender() {
  clearTimeout(biomeRenderTimer);
  biomeRenderTimer = setTimeout(renderBiomeMap, 140);
}
function getBiomeWorker() {
  if (biomeWorker) return biomeWorker;
  try { biomeWorker = new Worker("js/biome-worker.js", { type: "module" }); }
  catch (e) { return null; }
  biomeWorker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "progress") { if (els.smBiomeStatus) els.smBiomeStatus.textContent = `rendering… ${m.pct}%`; }
    else if (m.type === "done") onBiomeDone(m);
    else if (m.type === "points") onCandidateBiomes(m);
    else if (m.type === "error") { biomeState.busy = false; if (els.smBiomeStatus) els.smBiomeStatus.textContent = "⚠ " + m.message; }
  };
  biomeWorker.onerror = (e) => { biomeState.busy = false; if (els.smBiomeStatus) els.smBiomeStatus.textContent = "⚠ biome worker error" + (e && e.message ? ": " + e.message : " (check console)"); };
  return biomeWorker;
}
function renderBiomeMap() {
  loadBiomeRemap(); loadStructures(); loadBiomeSpawns();
  biomeState.fromExport = false; // leaving a loaded export → back to computed biomes
  const cv = els.smBiomeCanvas;
  const bpp = Math.max(1, Number(els.smBiomeZoom.value) || 2);
  const cols = Math.round(cv.width / 2), rows = Math.round(cv.height / 2); // half-res sample, scaled up
  const cx = Math.round(Number(els.smCx.value) || 0), cz = Math.round(Number(els.smCz.value) || 0);
  const caves = !!(els.smBiomeCaves && els.smBiomeCaves.checked) && biomeState.dim === "overworld";
  biomeState.cx = cx; biomeState.cz = cz; biomeState.bpp = bpp; biomeState.cols = cols; biomeState.rows = rows; biomeState.caves = caves;
  const w = getBiomeWorker();
  if (!w) { els.smBiomeStatus.textContent = "⚠ module workers unsupported in this browser"; return; }
  if (biomeState.busy) { biomeRerender = true; return; } // queue the latest pan/zoom
  biomeState.busy = true;
  els.smBiomeStatus.textContent = "rendering… 0%";
  w.postMessage({ type: "render", seed: els.smSeed.value, cx, cz, bpp, cols, rows, dim: biomeState.dim, caves });
}
function onBiomeDone(m) {
  biomeState.busy = false;
  biomeState.rendered = true;
  biomeState.img = new ImageData(new Uint8ClampedArray(m.rgba), m.cols, m.rows);
  biomeState.grid = new Uint16Array(m.ids);
  biomeState.palette = m.palette;
  biomeState.legend = m.legend;
  drawBiomeCanvas(0, 0);
  renderBiomeLegend(m.legend);
  els.smBiomeStatus.textContent = `${m.legend.length} biomes · ${biomeState.bpp} blk/px · ${biomeState.cols * biomeState.bpp}×${biomeState.rows * biomeState.bpp} blocks`;
  if (biomeRerender) { biomeRerender = false; renderBiomeMap(); } // a pan/zoom queued during render
}
// Biome + world coords under the cursor, from the cached grid.
function biomeAtPointer(offsetX, offsetY) {
  if (!biomeState.grid) return null;
  const cv = els.smBiomeCanvas;
  const cx = Math.floor(offsetX / (cv.width / biomeState.cols));
  const cy = Math.floor(offsetY / (cv.height / biomeState.rows));
  if (cx < 0 || cx >= biomeState.cols || cy < 0 || cy >= biomeState.rows) return null;
  const orig = biomeState.palette[biomeState.grid[cy * biomeState.cols + cx]];
  const mapped = (BIOME_REMAP && BIOME_REMAP[orig]) || orig;
  const bx = Math.round(biomeState.cx - (biomeState.cols * biomeState.bpp) / 2 + (cx + 0.5) * biomeState.bpp);
  const bz = Math.round(biomeState.cz - (biomeState.rows * biomeState.bpp) / 2 + (cy + 0.5) * biomeState.bpp);
  return { orig, mapped, bx, bz };
}
// Original (pre-remap) biome at a world position, from the rendered grid — used
// to validate that a structure can actually generate at a candidate chunk.
function biomeAtWorld(x, z) {
  if (!biomeState.grid) return null;
  const cellX = Math.floor((x - (biomeState.cx - biomeState.cols * biomeState.bpp / 2)) / biomeState.bpp);
  const cellZ = Math.floor((z - (biomeState.cz - biomeState.rows * biomeState.bpp / 2)) / biomeState.bpp);
  if (cellX < 0 || cellX >= biomeState.cols || cellZ < 0 || cellZ >= biomeState.rows) return null;
  return biomeState.palette[biomeState.grid[cellZ * biomeState.cols + cellX]];
}
// dragX/dragY shift the cached image during a pan (visual only, before re-render).
function drawBiomeCanvas(dragX, dragY) {
  const cv = els.smBiomeCanvas, ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = DIM_BG[biomeState.dim] || "#0b1322"; ctx.fillRect(0, 0, cv.width, cv.height);
  if (biomeState.img) {
    const tmp = document.createElement("canvas"); tmp.width = biomeState.img.width; tmp.height = biomeState.img.height;
    tmp.getContext("2d").putImageData(biomeState.img, 0, 0);
    ctx.drawImage(tmp, (dragX || 0), (dragY || 0), cv.width, cv.height);
  }
  drawBiomeStructures(ctx, dragX || 0, dragY || 0);
}
// Cave/underground structures: their required biome only exists deep below, so
// the surface biome map (and the surface-sampled probe) can't validate them —
// flag for /locate instead of dimming. (e.g. giovanni→frostfire_caves, angelo→lush_caves)
const CAVE_BIOME_RE = /(?:^|:)cave\/|caves$|lush_caves|dripstone_caves|deep_dark|frostfire/;
function structUnderground(st) {
  return !!(st && st.biomes && st.biomes.length && st.biomes.every((b) => CAVE_BIOME_RE.test(b)));
}
// Is a candidate on its structure's biome? true / false / null (can't tell).
// The game checks the biome at the chunk CENTER (getMiddleBlockPosition = x,z),
// so we sample there too — sampling the corner flips biomes on borders (an
// Articuno Altar reads snowy_beach at the corner but snowy_plains at the center).
// Cobbleverse biome lists are exact (verified against the datapacks), so we match
// exactly. probeOnly=true uses ONLY the loaded probe (authoritative — safe to
// hide/exclude on); else we also consult the deepslate render (advisory). Underground
// structures (cave biomes) can't be judged from the surface at all.
function candMatch(st, x, z, probeOnly, caveLayer) {
  if (!st.biomes || !st.biomes.length) return null;
  // Each map layer judges only its own structures: the surface map can't see cave
  // biomes, the cave map can't see surface biomes.
  if (!!caveLayer !== structUnderground(st)) return null;
  let wb = null;
  if (!caveLayer && structureProbe && structureProbe.dim === biomeState.dim) {
    const p = structureProbe.byKey.get(x + "," + z); // probe is already post-replacement
    if (p != null) wb = p;
  }
  if (wb == null) {
    if (probeOnly) return null;
    const raw = biomeAtWorld(x, z);
    if (raw == null) return null;
    wb = (BIOME_REMAP && BIOME_REMAP[raw]) || raw; // apply Biome Replacer to match the server
  }
  return st.biomes.indexOf(wb) >= 0;
}
function drawBiomeStructures(ctx, ox, oy) {
  const cv = els.smBiomeCanvas;
  const ppb = cv.width / (biomeState.cols * biomeState.bpp); // px per block
  const final = !ox && !oy;
  if (final) biomeIconHits = [];
  if (STRUCTURES && STRUCTURES.length) {
    const seed = seedToLong(els.smSeed.value);
    const halfX = (biomeState.cols * biomeState.bpp) / 2, halfZ = (biomeState.rows * biomeState.bpp) / 2;
    const minX = biomeState.cx - halfX, maxX = biomeState.cx + halfX, minZ = biomeState.cz - halfZ, maxZ = biomeState.cz + halfZ;
    const TOTAL_CAP = 450, PER_CAP = 90;
    const showOff = !!(els.smBiomeMatch && els.smBiomeMatch.checked);
    const caveLayer = !!biomeState.caves;
    let total = 0;
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = "13px system-ui, sans-serif";
    for (const st of STRUCTURES) {            // rarest-first (structures.json is sorted)
      if ((st.dim || "overworld") !== biomeState.dim) continue; // structures of the current dimension
      if (total >= TOTAL_CAP) break;
      let n = 0;
      const underground = structUnderground(st);
      if (caveLayer && !underground) continue; // cave view shows only cave structures
      for (const c of structuresInView(seed, st, minX, maxX, minZ, maxZ)) {
        if (n >= PER_CAP || total >= TOTAL_CAP) break;
        // Biome match at the chunk CENTER (where the game checks), exact against the
        // datapack-accurate biome list. HIDE off-biome slots on the deepslate estimate
        // (user's choice — cleaner map). deepslate isn't bit-exact near spawn, so this can
        // occasionally hide a real structure or show a phantom; load 📡 /locate for the
        // bit-exact answer when it matters. Cave structures: amber ring, never off.
        const off = candMatch(st, c.x, c.z, false, caveLayer) === false; // probe-first, deepslate fallback
        if (off && !showOff) continue; // hide off-biome (estimate or probe) unless "Show off-biome"
        const px = cv.width / 2 + (c.x - biomeState.cx) * ppb + ox;
        const py = cv.height / 2 + (c.z - biomeState.cz) * ppb + oy;
        if (px < -8 || px > cv.width + 8 || py < -8 || py > cv.height + 8) continue;
        ctx.globalAlpha = off ? 0.42 : 1;
        ctx.fillStyle = "rgba(0,0,0,.5)"; ctx.beginPath(); ctx.arc(px, py, 8, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.fillText(st.icon, px, py + 0.5);
        if (underground && !caveLayer) { ctx.strokeStyle = "#ffd54a"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(px, py, 9.5, 0, Math.PI * 2); ctx.stroke(); } // amber = unjudged on surface layer; cave view validates it
        ctx.globalAlpha = 1;
        if (final) biomeIconHits.push({ x: px, y: py, st, bx: c.x, bz: c.z, match: !off, underground });
        n++; total++;
      }
    }
  }
  // view-centre dot (where you're looking)
  ctx.fillStyle = "#fff"; ctx.strokeStyle = "#0b1322"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(cv.width / 2 + ox, cv.height / 2 + oy, 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // permanent world-origin (0,0) crosshair — pans with the map
  const o0x = cv.width / 2 + (0 - biomeState.cx) * ppb + ox, o0z = cv.height / 2 + (0 - biomeState.cz) * ppb + oy;
  if (o0x >= -24 && o0x <= cv.width + 24 && o0z >= -24 && o0z <= cv.height + 24) {
    for (const [col, w] of [["rgba(0,0,0,.6)", 4], ["#ffd54a", 2]]) {
      ctx.strokeStyle = col; ctx.lineWidth = w;
      ctx.beginPath(); ctx.arc(o0x, o0z, 7, 0, Math.PI * 2);
      ctx.moveTo(o0x - 12, o0z); ctx.lineTo(o0x + 12, o0z);
      ctx.moveTo(o0x, o0z - 12); ctx.lineTo(o0x, o0z + 12); ctx.stroke();
    }
    ctx.font = "bold 11px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,.7)"; ctx.strokeText("0,0", o0x + 11, o0z - 7);
    ctx.fillStyle = "#ffd54a"; ctx.fillText("0,0", o0x + 11, o0z - 7);
    if (final) biomeIconHits.push({ x: o0x, y: o0z, st: { icon: "⌖", name: "World origin", target: "" }, bx: 0, bz: 0 });
  }
}
function biomeLabel(id) { return id.replace(/^minecraft:|^terralith:/, "").replace(/_/g, " "); }
// biome id -> spawn labels that cover it (built offline from the Cobblemon biome
// tags resolved against the server's biome set). Bridges concrete biome ids to the
// label-keyed BIOME_INDEX so a biome click can list what spawns there.
let BIOME_SPAWNS = null;
function loadBiomeSpawns() {
  if (BIOME_SPAWNS) return Promise.resolve();
  return fetch("js/data/biome-spawns.json").then((r) => r.json()).then((j) => { BIOME_SPAWNS = j; buildLabelBiomes(); }).catch(() => (BIOME_SPAWNS = {}));
}
// "What spawns here" for a clicked biome: union the species of every spawn label
// that covers this biome (excluding the generic "any overworld" wildcard, which is
// shown only as a count), best rarity per species.
function showBiomeSpawns(biomeId, origId) {
  const el = els.smBiomeSpawns; if (!el) return;
  loadBiomeSpawns().then(() => {
    const labels = (BIOME_SPAWNS && BIOME_SPAWNS[biomeId]) || [];
    const best = new Map();
    for (const lbl of labels) {
      if (lbl === "any overworld") continue;
      for (const x of (BIOME_INDEX[lbl] || [])) {
        const cur = best.get(x.dex);
        if (!cur || RARITY_ORDER[x.entry.r] < RARITY_ORDER[cur.entry.r]) best.set(x.dex, x);
      }
    }
    const list = [...best.values()].sort((a, b) => RARITY_ORDER[a.entry.r] - RARITY_ORDER[b.entry.r] || a.dex - b.dex);
    const owCount = labels.includes("any overworld") ? (PSEUDO_INDEX["any overworld"] || []).length : 0;
    const title = biomeLabel(biomeId) + (origId && origId !== biomeId ? ` <span class="muted">(Terralith: ${biomeLabel(origId)})</span>` : "");
    const close = `<button class="ctrl-btn ghost sm-bsp-close" title="Close">✕</button>`;
    if (!labels.length) {
      el.hidden = false;
      el.innerHTML = `<div class="sm-bsp-head"><b>🐾 ${title}</b>${close}</div><p class="hint">No spawn data for this biome (it may not exist in this dimension's spawn list).</p>`;
    } else {
      const cards = list.map(({ dex, entry }) => {
        const sp = DEX_BY_NUM[dex];
        const art = spawnCardArt(dex, entry); // variant render if this entry is a variant form
        return `<div class="mon" data-dex="${dex}" title="${entry.f ? entry.f + " · " : ""}${entryDetail(entry)}"><span class="badge r-${entry.r}">${entry.r[0].toUpperCase()}</span>` +
          `<img loading="lazy" src="${art.src}" onerror="this.onerror=null;this.src='${art.fb}'" alt="${sp ? sp.name : dex}"/><div class="dexno">#${String(dex).padStart(4, "0")}</div>` +
          `<div class="nm">${sp ? sp.name.replace(/-/g, " ") : dex}</div>${entry.f ? `<div class="form-tag">✦ ${entry.f}</div>` : ""}${entry.dp ? `<div class="form-tag dp-tag" title="Requires the ${dpName(entry.dp)} on the server">📦 DP</div>` : ""}</div>`;
      }).join("");
      el.hidden = false;
      el.innerHTML = `<div class="sm-bsp-head"><b>🐾 Spawns in ${title}</b> <span class="muted">· ${list.length} biome-specific${owCount ? ` · +${owCount} overworld-wide` : ""}</span>${close}</div>` +
        `<div class="grid sm-bsp-grid">${cards || '<p class="hint">Only overworld-wide species spawn here.</p>'}</div>`;
    }
    const btn = el.querySelector(".sm-bsp-close"); if (btn) btn.onclick = () => { el.hidden = true; };
  });
}
function renderBiomeLegend(legend) {
  if (!els.smBiomeLegend) return;
  els.smBiomeLegend.innerHTML = legend.slice().sort((a, b) => a.id.localeCompare(b.id))
    .map((l) => `<span class="sm-leg"><i style="background:${l.hex}"></i>${biomeLabel(l.id)}</span>`).join("");
}
// Drag-to-pan: shift visually while dragging, re-render centred on release.
let biomeDrag = null, biomeDownXY = null;
function wireBiomePan() {
  const cv = els.smBiomeCanvas;
  if (!cv) return;
  cv.addEventListener("pointerdown", (e) => {
    if (!biomeState.rendered) return;
    biomeDownXY = { x: e.offsetX, y: e.offsetY }; // tracked even for exports (no pan, but click works)
    if (biomeState.fromExport) return; // export is a fixed snapshot — no pan
    biomeDrag = { x: e.offsetX, y: e.offsetY };
    cv.setPointerCapture(e.pointerId); cv.style.cursor = "grabbing";
  });
  cv.addEventListener("pointermove", (e) => {
    if (biomeDrag) { drawBiomeCanvas(e.offsetX - biomeDrag.x, e.offsetY - biomeDrag.y); return; }
    if (!els.smBiomeHover) return;
    // structure icon under the cursor wins over the biome readout
    const hit = biomeIconHits.find((k) => Math.abs(k.x - e.offsetX) < 10 && Math.abs(k.y - e.offsetY) < 10);
    if (hit) { els.smBiomeHover.textContent = `${hit.st.icon} ${hit.st.name}${hit.st.target ? ` → ${hit.st.target}` : ""} · X ${hit.bx}, Z ${hit.bz}${hit.match === false ? " · ⚠ off-biome (may not generate)" : ""}`; return; }
    const h = biomeAtPointer(e.offsetX, e.offsetY); // hover readout
    els.smBiomeHover.textContent = h
      ? `${biomeLabel(h.mapped)}${h.mapped !== h.orig ? ` (Terralith: ${biomeLabel(h.orig)})` : ""} · X ${h.bx}, Z ${h.bz}` : "";
  });
  cv.addEventListener("pointerleave", () => { if (els.smBiomeHover) els.smBiomeHover.textContent = ""; });
  cv.addEventListener("pointerup", (e) => {
    const start = biomeDownXY; biomeDownXY = null;
    const wasDrag = !!biomeDrag; biomeDrag = null; cv.style.cursor = "grab";
    if (!start) return;
    const dx = e.offsetX - start.x, dy = e.offsetY - start.y;
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) { // click (not a pan) → what spawns here
      const h = biomeAtPointer(e.offsetX, e.offsetY);
      if (h) showBiomeSpawns(h.mapped, h.orig);
      return;
    }
    if (!wasDrag) return; // moved on an export → nothing to pan
    const ppb = cv.width / (biomeState.cols * biomeState.bpp);
    els.smCx.value = Math.round(biomeState.cx - dx / ppb);
    els.smCz.value = Math.round(biomeState.cz - dy / ppb); // keep the structure finder in sync
    renderBiomeMap();
  });
  // Scroll-wheel zoom, anchored on the cursor.
  cv.addEventListener("wheel", (e) => {
    if (!biomeState.rendered || biomeState.fromExport) return; // export is a fixed snapshot
    e.preventDefault();
    let i = BIOME_ZOOM_STEPS.indexOf(biomeState.bpp); if (i < 0) i = 1;
    const ni = Math.max(0, Math.min(BIOME_ZOOM_STEPS.length - 1, i + (e.deltaY > 0 ? 1 : -1)));
    if (ni === i) return;
    const newBpp = BIOME_ZOOM_STEPS[ni], W = cv.width, H = cv.height;
    const worldX = biomeState.cx + (e.offsetX - W / 2) * (biomeState.cols * biomeState.bpp) / W;
    const worldZ = biomeState.cz + (e.offsetY - H / 2) * (biomeState.rows * biomeState.bpp) / H;
    els.smCx.value = Math.round(worldX - (e.offsetX - W / 2) * (biomeState.cols * newBpp) / W);
    els.smCz.value = Math.round(worldZ - (e.offsetY - H / 2) * (biomeState.rows * newBpp) / H);
    biomeState.bpp = newBpp; if (els.smBiomeZoom) els.smBiomeZoom.value = String(newBpp);
    scheduleBiomeRender();
  }, { passive: false });
}

/* ---------- tabs ---------- */
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
  if (name === "boxes") renderBoxes(); // refresh in case dex changed on another tab
  if (name === "legendary") renderLegendary();
  if (name === "log") renderLog();
  if (name === "seedmap") renderSeedMap();
  if (name === "home") renderDashboard();
  if (name === "stats") renderStats();
  if (name === "sim") renderSim();
  if (name === "data") renderBackupCard();
  location.hash = name;
}

/* ---------- data tab ---------- */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "shinydex-hq-backup.json";
  a.click();
  URL.revokeObjectURL(a.href);
  // Record that the current state is now safely on disk, and clear any nudge.
  metaSet(META.backup, Date.now());
  metaSet(META.snooze, 0);
  renderBackupCard();
  refreshDashboard();
}
function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const d = JSON.parse(reader.result);
      if (!d || typeof d !== "object") throw new Error("bad file");
      state = Object.assign(freshState(), d);
      normalize();
      save();
      // The imported file is itself a backup the user holds, so treat the restored
      // state as backed up (don't immediately nag for an export).
      metaSet(META.backup, Date.now());
      metaSet(META.snooze, 0);
      renderDex(); renderForms(); renderVariants(); renderLegendary(); renderBerries(); renderParty();
      fillConfigInputs(); renderHunt(); renderBoxes(); renderSnack();
      renderDashboard(); renderStats(); renderLog(); renderBackupCard();
      const dexN = Object.keys(state.dex).length;
      const varN = Object.keys(state.variants).length;
      const berryN = Object.keys(state.berries).length;
      const huntN = Object.values(state.hunt.sessions || {}).filter((s) => s && s.count > 0).length;
      alert(`Imported — ${dexN} dex, ${varN} variants, ${berryN} berries, ${huntN} active hunts.`);
    } catch (e) { alert("Import failed: " + e.message); }
  };
  reader.readAsText(file);
}

/* ---------- ShinyDex Link (Minecraft mod) import ----------
 * The ShinyDex Link server mod (../shiny-dex-site-link) reports what you've
 * actually caught in-game. Rather than the manual JSON backup, this reads the
 * mod's export and merges it onto your dex. It only ever UPGRADES a species'
 * state (none → seen → caught → ✨ shiny) — it never downgrades, and it never
 * touches a manually 📦 boxed mon (boxed is a site-only step above shiny that
 * the mod has no concept of). So importing is always safe to repeat. */
const MOD_STATE_RANK = { none: 0, seen: 1, caught: 2, shiny: 3, boxed: 4 };

// Lazily-built normalized species-name → dex lookup. Cobblemon sends lowercase
// names ("mareep", "nidoran-f", "mr-mime"); strip non-alphanumerics so we're
// forgiving about separators (- _ space, etc.).
let DEX_BY_NAME = null;
function normSpeciesName(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function buildNameLookup() {
  DEX_BY_NAME = {};
  for (const sp of SPECIES) DEX_BY_NAME[normSpeciesName(sp.name)] = sp.dex;
}

// Pull a flat list of catch/dex entries out of whatever shape the export takes:
// a bare array, or an object wrapping pokemon/entries/catches/events/queue.
function modEntries(d) {
  if (Array.isArray(d)) return d;
  if (d && typeof d === "object") {
    for (const k of ["pokemon", "entries", "catches", "events", "queue"]) {
      if (Array.isArray(d[k])) return d[k];
    }
    if (d.event && typeof d.event === "object") return [d];
  }
  return null;
}

// event_queue.json holds QueuedEvent objects ({event:{…}, queuedAt, …}); unwrap
// to the catch payload. A snapshot/catches entry is already the payload.
function modPayload(e) {
  return e && typeof e.event === "object" && e.event ? e.event : e;
}

// Lenient truthy for flags like shiny/caught — accept boolean true, 1, or the
// strings "true"/"1"/"yes" (but NOT "false"). Mirrors the backend's truthy().
function flagTrue(v) {
  if (v === true || v === 1) return true;
  if (typeof v === "string") return ["true", "1", "yes"].includes(v.trim().toLowerCase());
  return false;
}

// Decide the dex state a single entry implies. Returns null if it says nothing.
function modEntryState(e) {
  const shiny = flagTrue(e.shiny) || (Array.isArray(e.aspects) && e.aspects.includes("shiny"));
  if (shiny) return "shiny";
  if (flagTrue(e.caught) || e.eventType === "pokemon_caught") return "caught";
  if (flagTrue(e.seen)) return "seen";
  // A species named with no flags at all (e.g. a queued catch payload) is a catch.
  if ((e.species || e.displayName) && e.caught === undefined && e.seen === undefined && e.eventType === undefined) return "caught";
  return null;
}

// Resolve a national-dex number from an explicit field or the species name.
function modEntryDex(e) {
  const direct = Number(e.dex ?? e.dexNumber ?? e.nationalDex ?? e.national_dex);
  if (Number.isFinite(direct) && direct > 0) return direct;
  if (!DEX_BY_NAME) buildNameLookup();
  const key = normSpeciesName(e.species || e.displayName || e.name);
  return key ? DEX_BY_NAME[key] : undefined;
}

// Resolve a Variants-tab entry for a mod export entry from its Cobblemon aspects
// (or form name), keyed by national dex. Mirrors the backend's resolveVariant().
function modEntryVariant(e, dex) {
  if (!Number.isFinite(dex)) return null;
  if (!VARIANT_BY_DEXFORM) buildVariantLookup();
  if (!VARIANT_BY_DEXFORM) return null;
  const tokens = [];
  if (Array.isArray(e.aspects)) tokens.push(...e.aspects);
  if (e.form) { tokens.push(e.form); tokens.push(String(e.form).split(" / ")[0]); }
  for (const t of tokens) {
    const v = VARIANT_BY_DEXFORM[dex + "|" + normSpeciesName(t)];
    if (v) return v;
  }
  return null;
}

function importModSync(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const status = els.modImportStatus;
    const show = (msg, ok) => {
      if (!status) { if (!ok) alert(msg); return; }
      status.hidden = false;
      status.textContent = msg;
      status.dataset.tone = ok ? "good" : "bad";
    };
    try {
      const d = JSON.parse(reader.result);
      const entries = modEntries(d);
      if (!entries) throw new Error("not a ShinyDex Link export (no catch list found)");

      let upgraded = 0, variantsUp = 0, already = 0, unknown = 0;
      const unknownNames = new Set();
      for (const raw of entries) {
        const e = modPayload(raw);
        if (!e || typeof e !== "object") continue;
        const next = modEntryState(e);
        if (!next) continue;
        const dex = modEntryDex(e);
        if (!Number.isFinite(dex) || !DEX_BY_NUM[dex]) {
          unknown++;
          unknownNames.add(e.species || e.displayName || e.name || String(e.dex ?? "?"));
          continue;
        }
        const cur = dexState(dex);
        if (MOD_STATE_RANK[next] > MOD_STATE_RANK[cur]) {
          const wasShiny = cur === "shiny" || cur === "boxed";
          setDexState(dex, next); upgraded++;
          if (!wasShiny && (next === "shiny" || next === "boxed")) logFindFromMod(dex);
        }
        else already++;
        // Regional/cosmetic/cobblemon form → Variants tab (caught/shiny only).
        if (next === "caught" || next === "shiny") {
          const v = modEntryVariant(e, dex);
          if (v) {
            const vcur = state.variants[v.id];
            const vRank = vcur === "shiny" ? 3 : (vcur ? 2 : 0);
            if (MOD_STATE_RANK[next] > vRank) { state.variants[v.id] = next === "shiny" ? "shiny" : true; variantsUp++; }
          }
        }
      }

      if (upgraded || variantsUp) {
        save();
        renderDex(); renderForms(); renderVariants(); renderLegendary(); renderBerries();
        renderBoxes(); renderDashboard(); renderStats(); renderLog(); renderBackupCard();
      }
      const parts = [`Synced from mod — ${upgraded} updated`];
      if (variantsUp) parts.push(`${variantsUp} variants`);
      if (already) parts.push(`${already} already current`);
      if (unknown) {
        const sample = [...unknownNames].slice(0, 3).join(", ");
        parts.push(`${unknown} unrecognized${sample ? ` (${sample}${unknownNames.size > 3 ? "…" : ""})` : ""}`);
      }
      show(parts.join(" · "), true);
    } catch (e) { show("Mod import failed: " + e.message, false); }
  };
  reader.readAsText(file);
}

/* ---------- element refs + wiring ---------- */
const els = {};
function grabEls() {
  Object.assign(els, {
    dexGrid: document.getElementById("dex-grid"),
    dexStats: document.getElementById("dex-stats"),
    dexSearch: document.getElementById("dex-search"),
    dexGen: document.getElementById("dex-gen"),
    dexFilter: document.getElementById("dex-filter"),
    formsStats: document.getElementById("forms-stats"),
    variantsStats: document.getElementById("variants-stats"),
    variantSearch: document.getElementById("variant-search"),
    legendaryStats: document.getElementById("legendary-stats"),
    legCalcRate: document.getElementById("leg-calc-rate"),
    legCalcTarget: document.getElementById("leg-calc-target"),
    legCalcOut: document.getElementById("leg-calc-out"),
    berriesStats: document.getElementById("berries-stats"),
    berrySearch: document.getElementById("berry-search"),
    boxesStats: document.getElementById("boxes-stats"),
    boxSelect: document.getElementById("box-select"),
    boxGrid: document.getElementById("box-grid"),
    boxSearch: document.getElementById("box-search"),
    huntModeDesc: document.getElementById("hunt-mode-desc"),
    huntSprite: document.getElementById("hunt-sprite"),
    huntTarget: document.getElementById("hunt-target"),
    huntCount: document.getElementById("hunt-count"),
    huntCountLabel: document.getElementById("hunt-count-label"),
    huntOdds: document.getElementById("hunt-odds"),
    huntInput: document.getElementById("hunt-input"),
    huntOrigin: document.getElementById("hunt-origin"),
    huntRandomScope: document.getElementById("hunt-random-scope"),
    showcaseModal: document.getElementById("showcase-modal"),
    showcaseCanvas: document.getElementById("showcase-canvas"),
    showcaseOrigin: document.getElementById("showcase-origin"),
    showcaseDownload: document.getElementById("showcase-download"),
    showcaseShare: document.getElementById("showcase-share"),
    showcaseCopy: document.getElementById("showcase-copy"),
    speciesList: document.getElementById("species-list"),
    huntFinds: document.getElementById("hunt-finds"),
    logSearch: document.getElementById("log-search"),
    logSort: document.getElementById("log-sort"),
    smSeed: document.getElementById("sm-seed"),
    smCx: document.getElementById("sm-cx"),
    smCz: document.getElementById("sm-cz"),
    smRadius: document.getElementById("sm-radius"),
    smBiomeRender: document.getElementById("sm-biome-render"),
    smBiomeZoom: document.getElementById("sm-biome-zoom"),
    smBiomeMatch: document.getElementById("sm-biome-match"),
    smBiomeCaves: document.getElementById("sm-biome-caves"),
    smBiomeFile: document.getElementById("sm-biome-file"),
    smProbeFile: document.getElementById("sm-probe-file"),
    smLocatedFile: document.getElementById("sm-located-file"),
    smBiomeStatus: document.getElementById("sm-biome-status"),
    smBiomeCanvas: document.getElementById("sm-biome-canvas"),
    smBiomeLegend: document.getElementById("sm-biome-legend"),
    smBiomeHover: document.getElementById("sm-biome-hover"),
    smBiomeSpawns: document.getElementById("sm-biome-spawns"),
    huntActiveCard: document.getElementById("hunt-active-card"),
    huntActive: document.getElementById("hunt-active"),
    cfgBase: document.getElementById("cfg-base"),
    cfgThresholds: document.getElementById("cfg-thresholds"),
    cfgMasuda: document.getElementById("cfg-masuda"),
    cfgHotkey: document.getElementById("cfg-hotkey"),
    cfgHotkeyClear: document.getElementById("cfg-hotkey-clear"),
    spawnInput: document.getElementById("spawn-input"),
    spawnBiomeSelect: document.getElementById("spawn-biome-select"),
    spawnResults: document.getElementById("spawn-results"),
    snackBiome: document.getElementById("snack-biome"),
    snackNearWater: document.getElementById("snack-near-water"),
    snackSummary: document.getElementById("snack-summary"),
    snackBaseRate: document.getElementById("snack-base-rate"),
    snackTarget: document.getElementById("snack-target"),
    snackShinyOut: document.getElementById("snack-shiny-out"),
    snackBestInput: document.getElementById("snack-best-input"),
    snackBestOut: document.getElementById("snack-best-out"),
    snackResults: document.getElementById("snack-results"),
    simBiome: document.getElementById("sim-biome"),
    simY: document.getElementById("sim-y"),
    simHeight: document.getElementById("sim-height"),
    simLight: document.getElementById("sim-light"),
    simTime: document.getElementById("sim-time"),
    simWeather: document.getElementById("sim-weather"),
    simBase: document.getElementById("sim-base"),
    simOpenSky: document.getElementById("sim-open-sky"),
    simWater: document.getElementById("sim-water"),
    simItems: document.getElementById("sim-items"),
    simBaseRate: document.getElementById("sim-base-rate"),
    simTarget: document.getElementById("sim-target"),
    simShinyOut: document.getElementById("sim-shiny-out"),
    simBestInput: document.getElementById("sim-best-input"),
    simBestOut: document.getElementById("sim-best-out"),
    simSummary: document.getElementById("sim-summary"),
    simResults: document.getElementById("sim-results"),
    farmTrees: document.getElementById("farm-trees"),
    farmGrowth: document.getElementById("farm-growth"),
    farmYield: document.getElementById("farm-yield"),
    farmPerBall: document.getElementById("farm-perball"),
    farmTarget: document.getElementById("farm-target"),
    farmApricornOut: document.getElementById("farm-apricorn-out"),
    farmOdds: document.getElementById("farm-odds"),
    farmRate: document.getElementById("farm-rate"),
    farmShinyOut: document.getElementById("farm-shiny-out"),
    exportBtn: document.getElementById("export-btn"),
    importBtn: document.getElementById("import-btn"),
    importFile: document.getElementById("import-file"),
    resetAll: document.getElementById("reset-all"),
    modImportBtn: document.getElementById("mod-import-btn"),
    modImportFile: document.getElementById("mod-import-file"),
    modImportStatus: document.getElementById("mod-import-status"),
    modLinkBtn: document.getElementById("mod-link-btn"),
    modPullBtn: document.getElementById("mod-pull-btn"),
    modLinkCode: document.getElementById("mod-link-code"),
    modLinkStatus: document.getElementById("mod-link-status"),
    installBtn: document.getElementById("install-btn"),
    // Account / cloud sync
    accountUnconfigured: document.getElementById("account-unconfigured"),
    accountSignedout: document.getElementById("account-signedout"),
    accountSignedin: document.getElementById("account-signedin"),
    accountWho: document.getElementById("account-who"),
    accountStatus: document.getElementById("account-status"),
    accGoogle: document.getElementById("acc-google"),
    accEmail: document.getElementById("acc-email"),
    accPassword: document.getElementById("acc-password"),
    accLogin: document.getElementById("acc-login"),
    accSignup: document.getElementById("acc-signup"),
    accReset: document.getElementById("acc-reset"),
    authError: document.getElementById("auth-error"),
    accPull: document.getElementById("acc-pull"),
    accSignout: document.getElementById("acc-signout"),
    accountConflict: document.getElementById("account-conflict"),
    conflictLocal: document.getElementById("conflict-local"),
    conflictCloud: document.getElementById("conflict-cloud"),
    conflictKeepCloud: document.getElementById("conflict-keep-cloud"),
    conflictKeepLocal: document.getElementById("conflict-keep-local"),
    conflictMerge: document.getElementById("conflict-merge"),
  });
}

/* ---------- collapsible sidebar navigation ----------
 * Desktop: ☰ collapses the sidebar to icons (remembered per-device). Mobile
 * (≤860px): the sidebar is an off-canvas drawer that ☰ slides open over a
 * backdrop; picking a tab, tapping the backdrop, or Esc closes it. */
const NAV_COLLAPSE_KEY = "shinydex-nav-collapsed";
function navIsMobile() { return window.matchMedia("(max-width: 860px)").matches; }
function closeNavDrawer() { document.body.classList.remove("nav-open"); }
function setNavCollapsed(on) {
  document.body.classList.toggle("nav-collapsed", on);
  try { localStorage.setItem(NAV_COLLAPSE_KEY, on ? "1" : "0"); } catch (_) { /* private mode */ }
  const t = document.getElementById("nav-toggle");
  if (t) t.setAttribute("aria-expanded", on ? "false" : "true");
}
function initNav() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(NAV_COLLAPSE_KEY) === "1"; } catch (_) { /* ignore */ }
  document.body.classList.toggle("nav-collapsed", collapsed);
  const toggle = document.getElementById("nav-toggle");
  if (toggle) {
    toggle.setAttribute("aria-expanded", collapsed && !navIsMobile() ? "false" : "true");
    toggle.addEventListener("click", () => {
      if (navIsMobile()) document.body.classList.toggle("nav-open");
      else setNavCollapsed(!document.body.classList.contains("nav-collapsed"));
    });
  }
  const backdrop = document.getElementById("sidebar-backdrop");
  if (backdrop) backdrop.addEventListener("click", closeNavDrawer);
  // Leaving mobile width with the drawer open would otherwise strand the overlay.
  window.addEventListener("resize", () => { if (!navIsMobile()) closeNavDrawer(); });
}

function wire() {
  document.getElementById("tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (t) { showTab(t.dataset.tab); if (navIsMobile()) closeNavDrawer(); }
  });
  initNav();

  // Dashboard: delegated so the buttons survive each renderDashboard() rebuild.
  const homePanel = document.getElementById("panel-home");
  if (homePanel) {
    homePanel.addEventListener("click", (e) => {
      const go = e.target.closest("[data-gotab]");
      if (go) { showTab(go.dataset.gotab); return; }
      if (e.target.closest("#dash-inc")) { bumpCount(1); return; }
      if (e.target.closest("#dash-dec")) { bumpCount(-1); return; }
      if (e.target.closest("#dash-found")) { foundShiny(false); return; }
      if (e.target.closest("#dash-boxed")) { foundShiny(true); return; }
      if (e.target.closest("#dash-surprise")) { randomHuntTarget(); refreshDashboard(); return; }
      if (e.target.closest("#dash-backup-export")) { exportData(); return; }
      if (e.target.closest("#dash-backup-snooze")) { snoozeBackup(); return; }
      if (e.target.closest("#goal-add-open")) { openGoalModal(); return; }
      const goalDel = e.target.closest(".goal-del");
      if (goalDel) { e.stopPropagation(); removeGoal(goalDel.dataset.goal); renderDashGoals(); return; }
      const nextHunt = e.target.closest(".next-hunt");
      if (nextHunt) { e.stopPropagation(); startHuntFor(Number(nextHunt.dataset.dex), "encounter"); return; }
      const formsTog = e.target.closest(".next-forms-toggle");
      if (formsTog) { e.stopPropagation(); const p = formsTog.closest(".next-main").querySelector(".next-forms"); if (p) p.hidden = !p.hidden; return; }
      const formBtn = e.target.closest(".next-form");
      if (formBtn) { e.stopPropagation(); if (formBtn.dataset.variant) startHuntFromVariant(formBtn.dataset.variant); else startHuntFor(Number(formBtn.dataset.dex), "encounter"); return; }
      const gapHunt = e.target.closest(".dash-gap-hunt");
      if (gapHunt) { e.stopPropagation(); if (gapHunt.dataset.variant) startHuntFromVariant(gapHunt.dataset.variant); else openHuntStart(Number(gapHunt.dataset.dex)); return; }
      const gapBox = e.target.closest(".dash-gap-box");
      if (gapBox) { e.stopPropagation(); markBoxed(Number(gapBox.dataset.dex)); return; }
      const wlStar = e.target.closest(".dash-wl-star");
      if (wlStar) {
        e.stopPropagation();
        if (wlStar.dataset.variant) { toggleVariantWishlist(wlStar.dataset.variant); renderVariants(); }
        else { toggleWishlist(Number(wlStar.dataset.dex)); renderDex(); }
        refreshDashboard(); return;
      }
      const vgap = e.target.closest(".dash-gap[data-variant]");
      if (vgap) { startHuntFromVariant(vgap.dataset.variant); return; }
      const gap = e.target.closest(".dash-gap[data-dex]");
      if (gap) { showTab("boxes"); jumpToSpecies(DEX_BY_NUM[Number(gap.dataset.dex)]); return; }
    });
    homePanel.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const gap = e.target.closest(".dash-gap[data-dex]");
      if (gap) { e.preventDefault(); showTab("boxes"); jumpToSpecies(DEX_BY_NUM[Number(gap.dataset.dex)]); }
    });
    // "What to hunt next" biome picker.
    homePanel.addEventListener("change", (e) => {
      const sel = e.target.closest("#dash-next-biome");
      if (sel) { state.config.huntBiome = sel.value; save(); renderDashNext(); }
    });
  }

  // Dex grid: 🎯 starts a hunt; otherwise click cycles forward, right-click back.
  els.dexGrid.addEventListener("click", (e) => {
    const infoBtn = e.target.closest(".mon-info");
    if (infoBtn) { e.stopPropagation(); openMonDetail(Number(infoBtn.closest(".mon").dataset.dex)); return; }
    const huntBtn = e.target.closest(".mon-hunt");
    if (huntBtn) { e.stopPropagation(); openHuntStart(Number(huntBtn.closest(".mon").dataset.dex)); return; }
    const starBtn = e.target.closest(".mon-star");
    if (starBtn) {
      e.stopPropagation();
      const card = starBtn.closest(".mon");
      toggleWishlist(Number(card.dataset.dex));
      refreshCard(card, Number(card.dataset.dex));
      return;
    }
    const card = e.target.closest(".mon");
    if (!card) return;
    cycleDex(Number(card.dataset.dex), false);
    refreshCard(card, Number(card.dataset.dex));
  });
  els.dexGrid.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".mon-hunt") || e.target.closest(".mon-star")) { e.preventDefault(); return; }
    const card = e.target.closest(".mon");
    if (!card) return;
    e.preventDefault();
    cycleDex(Number(card.dataset.dex), true);
    refreshCard(card, Number(card.dataset.dex));
  });

  // Forms grid: toggle unlocked.
  document.getElementById("panel-forms").addEventListener("click", (e) => {
    const card = e.target.closest(".mon");
    if (!card || !card.dataset.form) return;
    const id = card.dataset.form;
    if (state.forms[id]) delete state.forms[id]; else state.forms[id] = true;
    save(); renderForms();
  });

  // Variants grid: toggle caught (in-place so a tap doesn't rebuild 270 cards).
  document.getElementById("panel-variants").addEventListener("click", (e) => {
    const huntBtn = e.target.closest(".v-hunt");
    if (huntBtn) { e.stopPropagation(); startHuntFromVariant(huntBtn.dataset.variant); return; }
    const starBtn = e.target.closest(".v-star");
    if (starBtn) {
      e.stopPropagation();
      toggleVariantWishlist(starBtn.dataset.variant);
      const v = VARIANT_BY_ID[starBtn.dataset.variant];
      if (v) starBtn.closest(".mon").replaceWith(variantCard(v));
      refreshDashboard();
      return;
    }
    const card = e.target.closest(".mon");
    if (!card || !card.dataset.variant) return;
    const id = card.dataset.variant;
    // Cycle none -> caught -> shiny -> none.
    const cur = state.variants[id];
    if (!cur) state.variants[id] = true;
    else if (cur === true) state.variants[id] = "shiny";
    else delete state.variants[id];
    save();
    const v = allVariants().find((x) => x.id === id);
    if (v) card.replaceWith(variantCard(v));
    renderVariantsStats();
  });
  els.variantSearch.addEventListener("input", renderVariants);

  // Legendary tab: cycle a card's state, or copy a structure's /locate command.
  document.getElementById("panel-legendary").addEventListener("click", (e) => {
    const chip = e.target.closest(".leg-locate");
    if (chip) {
      const cmd = `/locate structure ${chip.dataset.locate}`;
      const flash = () => { const o = chip.textContent; chip.textContent = "✓ copied"; setTimeout(() => (chip.textContent = o), 1000); };
      if (navigator.clipboard) navigator.clipboard.writeText(cmd).then(flash, flash); else flash();
      return;
    }
    // Card action buttons (mirror the Dex cards): hunt / favorite / details.
    const legDexOf = (btn) => Number(btn.closest(".mon").dataset.legDex);
    const huntBtn = e.target.closest(".mon-hunt");
    if (huntBtn) { e.stopPropagation(); openHuntStart(legDexOf(huntBtn)); return; }
    const starBtn = e.target.closest(".mon-star");
    if (starBtn) {
      e.stopPropagation();
      const d = legDexOf(starBtn);
      toggleWishlist(d);                       // shared ★ wishlist — also shows on the Dex page & dashboard
      const entry = LEGEND_BY_DEX[d];
      if (entry) starBtn.closest(".mon").replaceWith(legendCard(entry));
      syncDexCard(d); refreshDashboard();
      return;
    }
    const infoBtn = e.target.closest(".mon-info");
    if (infoBtn) { e.stopPropagation(); openMonDetail(legDexOf(infoBtn)); return; } // unified page: spawns + dex + legendary
    const card = e.target.closest(".mon");
    if (!card || !card.dataset.legDex) return;
    const dex = Number(card.dataset.legDex);
    const cur = state.legendaries[dex];
    if (!cur) state.legendaries[dex] = true;
    else if (cur === true) state.legendaries[dex] = "shiny";
    else delete state.legendaries[dex];
    save();
    const entry = LEGEND_BY_DEX[dex];
    if (entry) card.replaceWith(legendCard(entry));
    renderLegendaryStats();
  });
  // Legendary shiny calculator: rate input, quick-rate presets, target select.
  if (els.legCalcRate) {
    els.legCalcRate.addEventListener("input", renderLegCalc);
    els.legCalcTarget.addEventListener("change", () => {
      const dex = els.legCalcTarget.value ? Number(els.legCalcTarget.value) : null;
      const e = dex ? LEGEND_BY_DEX[dex] : null;
      if (e) els.legCalcRate.value = e.shiny; // sync rate to the picked legendary
      renderLegCalc();
    });
    document.querySelectorAll(".quick-rate").forEach((b) => b.addEventListener("click", () => {
      els.legCalcRate.value = b.dataset.rate;
      renderLegCalc();
    }));
  }

  // Berries tab: search + kind filter chips.
  if (els.berrySearch) els.berrySearch.addEventListener("input", renderBerries);
  document.querySelectorAll(".berry-filter").forEach((btn) => btn.addEventListener("click", () => {
    berryFilter = btn.dataset.kind;
    document.querySelectorAll(".berry-filter").forEach((b) => b.classList.toggle("active", b === btn));
    renderBerries();
  }));
  // Click a card to track it (collected); click a mutation's 🌳 button for its tree.
  const berriesList = document.getElementById("berries-list");
  if (berriesList) berriesList.addEventListener("click", (e) => {
    const treeBtn = e.target.closest("[data-tree]");
    if (treeBtn) { e.stopPropagation(); openBerryTree(treeBtn.dataset.tree); return; }
    const card = e.target.closest(".berry");
    if (!card || !card.dataset.berry) return;
    const id = card.dataset.berry;
    if (state.berries[id]) delete state.berries[id]; else state.berries[id] = true;
    save();
    card.replaceWith(berryCard(GUIDE_BY_ID[id]));
    renderBerriesStats();
  });
  const berryModal = document.getElementById("berry-modal");
  if (berryModal) berryModal.addEventListener("click", (e) => {
    if (e.target === berryModal || e.target.closest("[data-close]")) berryModal.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (berryModal && !berryModal.hidden) berryModal.hidden = true;
    const hsm = document.getElementById("hunt-start-modal");
    if (hsm && !hsm.hidden) closeHuntStart();
    if (els.showcaseModal && !els.showcaseModal.hidden) els.showcaseModal.hidden = true;
    const dm = document.getElementById("mon-detail-modal");
    if (dm && !dm.hidden) closeMonDetail();
    const gm = document.getElementById("goal-modal");
    if (gm && !gm.hidden) closeGoalModal();
    if (document.body.classList.contains("nav-open")) closeNavDrawer();
  });

  els.dexSearch.addEventListener("input", renderDex);
  els.dexGen.addEventListener("change", renderDex);
  els.dexFilter.addEventListener("change", renderDex);

  // Start-a-hunt chooser (opened from a Dex card's 🎯 button).
  const huntStartModal = document.getElementById("hunt-start-modal");
  if (huntStartModal) huntStartModal.addEventListener("click", (e) => {
    if (e.target === huntStartModal || e.target.closest("[data-close]")) { closeHuntStart(); return; }
    const mb = e.target.closest("[data-hsmode]");
    if (mb) startHuntFromDex(mb.dataset.hsmode);
  });

  // Add-a-goal modal.
  const goalModal = document.getElementById("goal-modal");
  if (goalModal) {
    goalModal.addEventListener("click", (e) => {
      if (e.target === goalModal || e.target.closest("[data-close]")) { closeGoalModal(); return; }
      if (e.target.closest("#goal-add")) {
        if (addGoal(buildGoalFromModal())) { closeGoalModal(); refreshDashboard(); }
        else updateGoalModalFields();
      }
    });
    goalModal.addEventListener("change", (e) => { if (e.target.closest("#goal-type, #goal-gen, #goal-target")) updateGoalModalFields(); });
    goalModal.addEventListener("input", (e) => { if (e.target.closest("#goal-target")) updateGoalModalFields(); });
  }

  // Per-Pokémon detail modal: all interactions delegated so they survive each
  // renderMonDetail() rebuild. Most actions jump to the relevant tab + close.
  const detailModal = document.getElementById("mon-detail-modal");
  if (detailModal) detailModal.addEventListener("click", (e) => {
    if (e.target === detailModal || e.target.closest("[data-close]")) { closeMonDetail(); return; }
    const dexOf = (sel) => Number(e.target.closest(sel).dataset.dex);
    const stBtn = e.target.closest(".md-st-btn");
    if (stBtn) { setDexState(Number(stBtn.dataset.dex), stBtn.dataset.st); renderMonDetail(); return; }
    const star = e.target.closest(".md-star");
    if (star) { const d = dexOf(".md-star"); toggleWishlist(d); syncDexCard(d); refreshDashboard(); renderMonDetail(); return; }
    const hunt = e.target.closest(".md-hunt");
    if (hunt) { const d = dexOf(".md-hunt"); closeMonDetail(); openHuntStart(d); return; }
    // "🎯 Hunt" inside the embedded spawn card — load straight into the Hunt tab.
    const huntLink = e.target.closest(".hunt-link");
    if (huntLink) { const d = Number(huntLink.dataset.dex); closeMonDetail(); loadTarget(DEX_BY_NUM[d].name); showTab("hunt"); return; }
    const where = e.target.closest(".md-where");
    if (where) {
      const d = dexOf(".md-where"); closeMonDetail();
      setSpawnMode("mon"); els.spawnInput.value = DEX_BY_NUM[d].name; findSpawnByInput(els.spawnInput.value); showTab("spawns"); return;
    }
    const gobox = e.target.closest(".md-gobox");
    if (gobox) { const d = dexOf(".md-gobox"); closeMonDetail(); showTab("boxes"); jumpToSpecies(DEX_BY_NUM[d]); return; }
    const snackPlan = e.target.closest(".md-snackplan");
    if (snackPlan) {
      const d = Number(snackPlan.dataset.dex); closeMonDetail(); showTab("snack");
      if (els.snackBestInput) { els.snackBestInput.value = DEX_BY_NUM[d].name; renderBestSnack(els.snackBestInput.value); }
      return;
    }
    const biome = e.target.closest(".biome-chip");
    if (biome) { closeMonDetail(); setSpawnMode("biome"); els.spawnBiomeSelect.value = biome.dataset.biome; renderSpawnResults(); showTab("spawns"); return; }
    const locate = e.target.closest(".leg-locate");
    if (locate) {
      const cmd = `/locate structure ${locate.dataset.locate}`;
      const flash = () => { const o = locate.textContent; locate.textContent = "✓ copied"; setTimeout(() => (locate.textContent = o), 1000); };
      if (navigator.clipboard) navigator.clipboard.writeText(cmd).then(flash, flash); else flash();
      return;
    }
    const vhunt = e.target.closest(".v-hunt");
    if (vhunt) { closeMonDetail(); startHuntFromVariant(vhunt.dataset.variant); return; }
    const vstar = e.target.closest(".v-star");
    if (vstar) { toggleVariantWishlist(vstar.dataset.variant); renderVariants(); refreshDashboard(); renderMonDetail(); return; }
    const vcard = e.target.closest(".mon[data-variant]");
    if (vcard) {
      const id = vcard.dataset.variant, cur = state.variants[id];
      if (!cur) state.variants[id] = true; else if (cur === true) state.variants[id] = "shiny"; else delete state.variants[id];
      save(); renderVariants(); refreshDashboard(); renderMonDetail(); return;
    }
    const del = e.target.closest(".find-del");
    if (del) { deleteFind(del.dataset.find); renderMonDetail(); return; }
    const fr = e.target.closest(".find-show");
    if (fr) { openShowcase(fr.dataset.find); return; }
  });

  // Origin select: remember the user's deliberate choice for this mode session.
  if (els.huntOrigin) els.huntOrigin.addEventListener("change", () => { els.huntOrigin.dataset.touched = "1"; });

  // Tapping any logged find (Hunt / Home / Log) opens its shareable showcase card;
  // the ✕ deletes the log instead (and must not also open the showcase).
  document.addEventListener("click", (e) => {
    const del = e.target.closest(".find-del[data-find]");
    if (del) { e.stopPropagation(); deleteFind(del.dataset.find); return; }
    const row = e.target.closest(".find-show[data-find]");
    if (row) openShowcase(row.dataset.find);
  });
  // Log tab: search + sort re-render the history list.
  if (els.logSearch) els.logSearch.addEventListener("input", renderLog);
  if (els.logSort) els.logSort.addEventListener("change", renderLog);

  // Seed Map tab.
  const smPanel = document.getElementById("panel-seedmap");
  if (smPanel) {
    smPanel.addEventListener("click", (e) => {
      if (e.target.closest("#sm-find")) { computeSeedMap(); return; }
      if (e.target.closest("#sm-biome-render")) { renderBiomeMap(); return; }
      const dimBtn = e.target.closest("#sm-dim .seg-btn");
      if (dimBtn) {
        biomeState.dim = dimBtn.dataset.dim;
        document.querySelectorAll("#sm-dim .seg-btn").forEach((b) => b.classList.toggle("active", b === dimBtn));
        biomeState.img = null; biomeState.grid = null; // drop the previous dimension's map
        renderBiomeMap();
        if (smLastResults) computeSeedMap(); // refresh the finder for the new dimension
        return;
      }
      const copy = e.target.closest(".sm-copy");
      if (copy) {
        const txt = copy.dataset.xz;
        const done = () => smCopyFlash(copy);
        if (navigator.clipboard) navigator.clipboard.writeText(txt).then(done, done); else done();
        return;
      }
    });
    if (els.smBiomeZoom) els.smBiomeZoom.addEventListener("change", () => { if (biomeState.rendered) renderBiomeMap(); });
    if (els.smBiomeMatch) els.smBiomeMatch.addEventListener("change", () => { if (biomeState.img || biomeState.dim === "end") drawBiomeCanvas(0, 0); renderSeedMapResults(); });
    if (els.smBiomeCaves) els.smBiomeCaves.addEventListener("change", () => { if (biomeState.rendered) renderBiomeMap(); });
    if (els.smBiomeFile) els.smBiomeFile.addEventListener("change", (e) => {
      const f = e.target.files[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { try { loadBiomeExport(JSON.parse(reader.result)); } catch (err) { els.smBiomeStatus.textContent = "⚠ couldn't read that file: " + err.message; } };
      reader.readAsText(f); e.target.value = "";
    });
    if (els.smProbeFile) els.smProbeFile.addEventListener("change", (e) => {
      const f = e.target.files[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { try { loadStructureProbe(JSON.parse(reader.result)); } catch (err) { els.smBiomeStatus.textContent = "⚠ couldn't read that file: " + err.message; } };
      reader.readAsText(f); e.target.value = "";
    });
    if (els.smLocatedFile) els.smLocatedFile.addEventListener("change", (e) => {
      const f = e.target.files[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { try { loadLocatedStructures(JSON.parse(reader.result)); } catch (err) { els.smBiomeStatus.textContent = "⚠ couldn't read that file: " + err.message; } };
      reader.readAsText(f); e.target.value = "";
    });
    wireBiomePan();
  }
  // Showcase modal: close, edit origin, export.
  if (els.showcaseModal) {
    els.showcaseModal.addEventListener("click", (e) => {
      if (e.target === els.showcaseModal || e.target.closest("[data-close]")) els.showcaseModal.hidden = true;
    });
    els.showcaseOrigin.addEventListener("change", () => {
      if (!showcaseFind) return;
      showcaseFind.origin = els.showcaseOrigin.value;
      save();
      renderShowcase();
      renderFinds(); refreshDashboard(); refreshStats();
    });
    els.showcaseDownload.addEventListener("click", showcaseDownload);
    els.showcaseShare.addEventListener("click", showcaseShare);
    els.showcaseCopy.addEventListener("click", showcaseCopy);
  }

  // Boxes tab
  document.getElementById("box-prev").addEventListener("click", () => gotoBox(curBox - 1));
  document.getElementById("box-next").addEventListener("click", () => gotoBox(curBox + 1));
  document.getElementById("box-gap").addEventListener("click", gotoFirstGap);
  els.boxSelect.addEventListener("change", () => gotoBox(Number(els.boxSelect.value)));
  // `input` fires when a datalist suggestion is picked (and on each keystroke);
  // jump only on an exact match so picking a suggestion works without a Go tap.
  els.boxSearch.addEventListener("input", () => { const sp = exactSpecies(els.boxSearch.value); if (sp) jumpToSpecies(sp); });
  els.boxSearch.addEventListener("keydown", (e) => { if (e.key === "Enter") jumpToMon(els.boxSearch.value); });
  document.getElementById("box-go").addEventListener("click", () => jumpToMon(els.boxSearch.value));
  els.boxGrid.addEventListener("click", (e) => {
    const info = e.target.closest(".slot-info");
    if (info) { e.stopPropagation(); openMonDetail(Number(info.closest(".slot").dataset.dex)); return; }
    const slot = e.target.closest(".slot"); if (!slot) return;
    cycleDex(Number(slot.dataset.dex), false); renderBoxes(); syncDexCard(Number(slot.dataset.dex));
  });
  els.boxGrid.addEventListener("contextmenu", (e) => {
    const slot = e.target.closest(".slot"); if (!slot) return;
    e.preventDefault();
    cycleDex(Number(slot.dataset.dex), true); renderBoxes(); syncDexCard(Number(slot.dataset.dex));
  });

  // Hunt tab
  document.getElementById("hunt-mode").addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn"); if (b) setMode(b.dataset.mode);
  });
  document.getElementById("hunt-inc").addEventListener("click", () => bumpCount(1));
  document.getElementById("hunt-dec").addEventListener("click", () => bumpCount(-1));
  document.getElementById("hunt-set").addEventListener("click", () => {
    const s = activeSession(); if (!s) { alert("Load a target first."); return; }
    const v = prompt("Set count to:", s.count); const n = Number(v);
    if (Number.isFinite(n) && n >= 0) { s.count = Math.floor(n); save(); renderHunt(); }
  });
  document.getElementById("hunt-reset").addEventListener("click", () => {
    const s = activeSession(); if (s) { s.count = 0; save(); renderHunt(); }
  });
  document.getElementById("hunt-found").addEventListener("click", () => foundShiny(false));
  document.getElementById("hunt-boxed").addEventListener("click", () => foundShiny(true));
  document.getElementById("hunt-load").addEventListener("click", () => loadTarget(els.huntInput.value));
  document.getElementById("hunt-random").addEventListener("click", randomHuntTarget);
  // "Where can I find this?" → the target's spawn biomes/conditions on the Spawns tab.
  const huntWhere = document.getElementById("hunt-where");
  if (huntWhere) huntWhere.addEventListener("click", () => {
    const dex = state.hunt.activeDex;
    const sp = dex != null ? DEX_BY_NUM[dex] : null;
    if (!sp) return;
    setSpawnMode("mon");
    els.spawnInput.value = sp.name;
    findSpawnByInput(els.spawnInput.value);
    showTab("spawns");
  });
  document.getElementById("hunt-offhunt").addEventListener("click", () => logRandomCatch(false));
  document.getElementById("hunt-offhunt-box").addEventListener("click", () => logRandomCatch(true));
  els.huntRandomScope.addEventListener("change", () => { state.config.randomScope = els.huntRandomScope.value; save(); });
  els.huntActive.addEventListener("click", (e) => {
    const drop = e.target.closest(".ah-drop");
    if (drop) { e.stopPropagation(); dropHunt(drop.dataset.mode, Number(drop.dataset.dex), drop.dataset.variant || null); return; }
    const row = e.target.closest(".active-hunt");
    if (row) resumeHunt(row.dataset.mode, Number(row.dataset.dex), row.dataset.variant || null);
  });
  els.huntActive.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest(".active-hunt");
    if (row) { e.preventDefault(); resumeHunt(row.dataset.mode, Number(row.dataset.dex), row.dataset.variant || null); }
  });
  els.huntInput.addEventListener("keydown", (e) => { if (e.key === "Enter") loadTarget(els.huntInput.value); });
  document.getElementById("cfg-save").addEventListener("click", applyConfigInputs);
  document.getElementById("cfg-reset").addEventListener("click", () => {
    state.config = defaultConfig(); save(); fillConfigInputs(); renderHunt();
  });

  // Spawns tab
  document.getElementById("spawn-mode").addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn"); if (b) setSpawnMode(b.dataset.smode);
  });
  document.getElementById("spawn-find").addEventListener("click", () => findSpawnByInput(els.spawnInput.value));
  els.spawnInput.addEventListener("keydown", (e) => { if (e.key === "Enter") findSpawnByInput(els.spawnInput.value); });
  els.spawnBiomeSelect.addEventListener("change", renderSpawnResults);
  els.spawnResults.addEventListener("click", (e) => {
    const huntLink = e.target.closest(".hunt-link");
    if (huntLink) { loadTarget(DEX_BY_NUM[Number(huntLink.dataset.dex)].name); showTab("hunt"); return; }
    const chip = e.target.closest(".biome-chip");
    if (chip) { setSpawnMode("biome"); els.spawnBiomeSelect.value = chip.dataset.biome; renderSpawnResults(); return; }
    const mon = e.target.closest(".mon[data-dex]");
    if (mon) { setSpawnMode("mon"); els.spawnInput.value = DEX_BY_NUM[Number(mon.dataset.dex)].name; findSpawnByInput(els.spawnInput.value); }
  });

  // PokéSnack tab
  els.snackBiome.addEventListener("change", () => {
    // Default the placement to match the biome: aquatic biomes start "near water".
    if (els.snackNearWater) els.snackNearWater.checked = biomeWaterShare(els.snackBiome.value) >= 0.5;
    renderSnack();
  });
  if (els.snackNearWater) els.snackNearWater.addEventListener("change", renderSnack);
  ["snack-s0", "snack-s1", "snack-s2"].forEach((id) =>
    document.getElementById(id).addEventListener("change", renderSnack));
  // Target / base-rate only affect the shiny estimate — no need to recompute attraction.
  els.snackTarget.addEventListener("change", () => { snackTarget = els.snackTarget.value; renderSnackShiny(selectedSeasonings()); });
  els.snackBaseRate.addEventListener("input", () => renderSnackShiny(selectedSeasonings()));
  // Best place & snack optimiser
  document.getElementById("snack-best-go").addEventListener("click", () => renderBestSnack(els.snackBestInput.value));
  els.snackBestInput.addEventListener("keydown", (e) => { if (e.key === "Enter") renderBestSnack(els.snackBestInput.value); });
  els.snackBestOut.addEventListener("click", (e) => {
    const btn = e.target.closest(".plan-apply"); if (!btn) return;
    applySnackPlan(btn.dataset.biome, btn.dataset.combo ? btn.dataset.combo.split(",") : [], Number(btn.dataset.dex));
  });
  els.snackResults.addEventListener("click", (e) => {
    const row = e.target.closest(".snack-row[data-dex]");
    if (!row) return;
    setSpawnMode("mon");
    els.spawnInput.value = DEX_BY_NUM[Number(row.dataset.dex)].name;
    findSpawnByInput(els.spawnInput.value);
    showTab("spawns");
  });

  // Spawn Sim tab: any control change re-runs the simulation.
  if (els.simBiome) {
    [els.simBiome, els.simY, els.simHeight, els.simLight, els.simTime, els.simWeather, els.simBase,
      els.simOpenSky, els.simWater,
      ...["sim-s0", "sim-s1", "sim-s2"].map((id) => document.getElementById(id))]
      .forEach((el) => el && el.addEventListener("change", renderSim));
    els.simY.addEventListener("input", renderSim);
    els.simHeight.addEventListener("input", renderSim);
    els.simLight.addEventListener("input", renderSim);
    els.simItems.addEventListener("change", renderSim);
    // Target / base-rate only re-do the shiny estimate, not the whole simulation.
    els.simTarget.addEventListener("change", () => { simTarget = els.simTarget.value; renderSimShiny(); });
    els.simBaseRate.addEventListener("input", renderSimShiny);
    // Optimizer: find best spot for a target, then load it into the controls.
    document.getElementById("sim-best-go").addEventListener("click", () => renderSimBest(els.simBestInput.value));
    els.simBestInput.addEventListener("keydown", (e) => { if (e.key === "Enter") renderSimBest(els.simBestInput.value); });
    els.simBestOut.addEventListener("click", (e) => {
      const btn = e.target.closest(".sim-plan-apply");
      if (btn && simBestPlans[+btn.dataset.plan]) applySimPlan(simBestPlans[+btn.dataset.plan]);
    });
    els.simResults.addEventListener("click", (e) => {
      const row = e.target.closest(".sim-row[data-dex]");
      if (!row) return;
      setSpawnMode("mon");
      els.spawnInput.value = DEX_BY_NUM[Number(row.dataset.dex)].name;
      findSpawnByInput(els.spawnInput.value);
      showTab("spawns");
    });
  }

  // Party tab: management buttons + delegated member edits.
  const partySelect = document.getElementById("party-select");
  if (partySelect) partySelect.addEventListener("change", (e) => selectParty(e.target.value));
  const pBtn = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener("click", fn); };
  pBtn("party-new", addParty);
  pBtn("party-rename", renameParty);
  pBtn("party-delete", deleteParty);
  pBtn("party-random", randomizeParty);
  pBtn("party-coach", openTeamCoach);
  const partyBody = document.getElementById("party-body");
  if (partyBody) {
    const onEdit = (e) => {
      const el = e.target.closest("[data-k]");
      if (!el) return;
      const slot = Number(el.dataset.slot);
      const k = el.dataset.k;
      if (k === "ev" || k === "iv") {
        partyEdit(slot, k, { stat: el.dataset.stat, value: el.value });
        // reflect the clamped value back into the field once editing settles
        if (e.type === "change") el.value = activeParty().members[slot][k === "ev" ? "evs" : "ivs"][el.dataset.stat];
        refreshMemberDerived(slot);
      } else if (k === "move") {
        partyEdit(slot, k, { i: Number(el.dataset.i), value: el.value });
        const dex = activeParty().members[slot].dex;
        el.classList.toggle("illegal", !!el.value && !moveOk(dex ? movepool(dex) : [], el.value));
      } else {
        partyEdit(slot, k, el.value);
        if (k === "species") refreshMemberDerived(slot);
      }
    };
    partyBody.addEventListener("input", onEdit);
    partyBody.addEventListener("change", onEdit);
    partyBody.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "coach") openCoach(Number(btn.dataset.slot));
      else partyAction(Number(btn.dataset.slot), btn.dataset.act);
    });
  }
  // Coach modal: apply or dismiss.
  const coachModal = document.getElementById("coach-modal");
  if (coachModal) {
    coachModal.addEventListener("click", (e) => {
      const up = e.target.closest(".tc-apply");
      if (up) { applyUpgrade(Number(up.dataset.slot), up.dataset.kind); return; }
      if (e.target.closest("#tc-apply-all")) { applyAllUpgrades(); return; }
      if (e.target.closest("#coach-apply")) { applyCoach(); return; }
      if (e.target === coachModal || e.target.closest("[data-close]")) coachModal.hidden = true;
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !coachModal.hidden) coachModal.hidden = true; });
  }

  // Farm tab
  ["farmTrees", "farmGrowth", "farmYield", "farmPerBall", "farmTarget"].forEach((k) =>
    els[k].addEventListener("input", renderFarmApricorn));
  ["farmOdds", "farmRate"].forEach((k) => els[k].addEventListener("input", renderFarmShiny));
  document.querySelectorAll(".quick-odds").forEach((b) =>
    b.addEventListener("click", () => quickOdds(b.dataset.odds)));

  // Configurable +1 hotkey. Two roles in one listener:
  //  - capture mode: clicking the settings button arms it; the next key becomes
  //    the hotkey (Esc cancels, bare modifiers ignored).
  //  - normal: the configured key does +1 on the active hunt FROM ANY TAB — but
  //    only while a hunt is active and you're not typing, so it never hijacks the
  //    key otherwise. Default Space; change it in Hunt → Odds settings.
  els.cfgHotkey.addEventListener("click", () => {
    capturingHotkey = true;
    els.cfgHotkey.textContent = "Press a key…";
    els.cfgHotkey.classList.add("capturing");
  });
  els.cfgHotkeyClear.addEventListener("click", () => {
    state.config.huntHotkey = ""; save(); refreshHotkeyBtn();
  });
  document.addEventListener("keydown", (e) => {
    if (capturingHotkey) {
      e.preventDefault();
      if (e.key !== "Escape" && !/^(Control|Shift|Alt|Meta|OS)/.test(e.code)) {
        state.config.huntHotkey = e.code; save();
      }
      refreshHotkeyBtn();
      return;
    }
    const hk = state.config.huntHotkey;
    if (!hk || e.code !== hk || e.repeat) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (state.hunt.activeDex == null) return; // no active hunt → leave the key alone
    const ae = document.activeElement;
    if (ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable)) return;
    e.preventDefault();
    bumpCount(1);
  });

  els.exportBtn.addEventListener("click", exportData);
  els.importBtn.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", (e) => { if (e.target.files[0]) importData(e.target.files[0]); });
  if (els.modImportBtn) els.modImportBtn.addEventListener("click", () => els.modImportFile.click());
  if (els.modImportFile) els.modImportFile.addEventListener("change", (e) => { if (e.target.files[0]) { importModSync(e.target.files[0]); e.target.value = ""; } });
  if (els.modLinkBtn) els.modLinkBtn.addEventListener("click", generateLinkCode);
  if (els.modPullBtn) els.modPullBtn.addEventListener("click", () => pullModDex({ silent: false }));
  els.resetAll.addEventListener("click", () => {
    if (confirm("Erase ALL progress? Export first if unsure.")) {
      state = freshState();
      save(); renderDex(); renderForms(); renderVariants(); renderLegendary(); renderBerries(); renderParty();
      fillConfigInputs(); renderHunt(); renderBoxes(); renderSnack(); renderDashboard(); renderStats(); renderLog();
      renderBackupCard();
    }
  });

  // Account / cloud sync controls (no-ops until cloud.js is configured).
  if (els.accGoogle) {
    els.accGoogle.addEventListener("click", () => cloudCall(() => window.ShinyCloud.signInGoogle()));
    els.accLogin.addEventListener("click", () => emailAuth(false));
    els.accSignup.addEventListener("click", () => emailAuth(true));
    els.accPassword.addEventListener("keydown", (e) => { if (e.key === "Enter") emailAuth(false); });
    els.accReset.addEventListener("click", () => {
      const email = (els.accEmail.value || "").trim();
      if (!email) { showAuthError("Enter your email above first, then tap Reset."); return; }
      cloudCall(() => window.ShinyCloud.sendReset(email), "Password reset email sent — check your inbox.");
    });
    els.accSignout.addEventListener("click", () => cloudCall(() => window.ShinyCloud.signOutUser()));
    els.accPull.addEventListener("click", pullFromCloud);
    els.conflictKeepCloud.addEventListener("click", () => finishConflict("cloud"));
    els.conflictKeepLocal.addEventListener("click", () => finishConflict("local"));
    els.conflictMerge.addEventListener("click", () => finishConflict("merge"));
  }
  window.addEventListener("offline", () => { if (cloudActive) setSyncBadge("offline"); });
  window.addEventListener("online", () => { if (cloudActive) scheduleCloudPush(); });
}

// Sync the Dex grid's card for one species after it was edited elsewhere (e.g. Boxes tab).
function syncDexCard(dex) {
  const card = els.dexGrid.querySelector(`.mon[data-dex="${dex}"]`);
  if (card) {
    const sp = DEX_BY_NUM[dex];
    if (matchesDexFilter(sp)) card.replaceWith(monCard(sp)); else card.remove();
  }
  renderDexStats();
}

// Re-render a single dex card in place after a state change (cheaper than full grid).
function refreshCard(oldCard, dex) {
  const sp = SPECIES.find((s) => s.dex === dex);
  // If the active filter would now hide it, re-render the whole grid.
  if (!matchesDexFilter(sp)) { renderDex(); return; }
  const fresh = monCard(sp);
  oldCard.replaceWith(fresh);
  renderDexStats();
}

/* ---------- install prompt + sw ---------- */
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); deferredPrompt = e;
  els.installBtn.hidden = false;
  els.installBtn.onclick = async () => { deferredPrompt.prompt(); deferredPrompt = null; els.installBtn.hidden = true; };
});
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

/* ---------- boot ---------- */
async function boot() {
  grabEls();
  load();
  // Cloud sync bridge — cloud.js (a deferred ES module) emits these once it loads.
  // Registering before it runs means a late auth/status event is never missed.
  window.addEventListener("cloud-auth", (e) => onCloudAuth(e.detail && e.detail.user));
  window.addEventListener("cloud-status", (e) => {
    const d = e.detail || {};
    if (d.state === "synced" && d.at) { lastSyncAt = d.at; metaSet(META.sync, d.at); renderBackupCard(); refreshDashboard(); }
    setSyncBadge(d.state, d.message);
    showAccountView();
  });
  showAccountView();
  const [sp, fm, spawns, berries, variants, berryGuide, moves, coach, legends, biomeSpawns] = await Promise.all([
    fetch("js/data/species.json").then((r) => r.json()),
    fetch("js/data/forms.json").then((r) => r.json()),
    fetch("js/data/spawns.json").then((r) => r.json()).catch(() => ({})),
    fetch("js/data/berries.json").then((r) => r.json()).catch(() => []),
    fetch("js/data/variants.json").then((r) => r.json()).catch(() => ({ regional: { alolan: [], galarian: [], hisuian: [], paldean: [] }, cosmetic: [], unown: [], cobblemon: [] })),
    fetch("js/data/berry-guide.json").then((r) => r.json()).catch(() => []),
    fetch("js/data/moves.json").then((r) => r.json()).catch(() => []),
    fetch("js/data/coach.json").then((r) => r.json()).catch(() => ({})),
    fetch("js/data/legendaries.json").then((r) => r.json()).catch(() => ({ tiers: [], list: [] })),
    fetch("js/data/biome-spawns.json").then((r) => r.json()).catch(() => ({})),
  ]);
  BIOME_SPAWNS = biomeSpawns;
  SPECIES = sp;
  MOVES = moves;
  MOVE_BY_NAME = {};
  MOVES.forEach((m) => (MOVE_BY_NAME[m.name] = m));
  COACH = coach;
  FORMS = { mega: fm.mega, primal: fm.primal, gmax: fm.gmax };
  VARIANTS = variants;
  LEGENDS = legends;
  LEGEND_BY_DEX = {};
  (LEGENDS.list || []).forEach((e) => (LEGEND_BY_DEX[e.dex] = e));
  SPAWNS = spawns;
  BERRIES = berries;
  BERRY_GUIDE = berryGuide;
  indexBerryGuide();
  BERRY_BY_ID = {};
  BERRIES.forEach((b) => (BERRY_BY_ID[b.id] = b));
  DEX_BY_NUM = {};
  SPECIES.forEach((s) => (DEX_BY_NUM[s.dex] = s));
  sanitizeSpawns();
  buildBiomeIndex();
  buildLabelBiomes();
  buildVariantLookup();
  SIM = await fetch("js/data/sim-spawns.json").then((r) => r.json())
    .catch(() => ({ spawns: {}, items: [], baseBlocks: [], hitbox: {} }));

  // Populate the target datalist once. Put the name in the label too, so browsers
  // that filter suggestions by the label (not the value) still match name typing.
  els.speciesList.innerHTML = SPECIES
    .map((s) => `<option value="${s.name}">#${String(s.dex).padStart(4, "0")} ${s.name}</option>`).join("");
  // Hunt-target autocomplete: species + variants (so "galarian meowth" suggests).
  const huntList = document.getElementById("hunt-target-list");
  if (huntList) {
    const ADJ = { galarian: "Galarian", alolan: "Alolan", hisuian: "Hisuian", paldean: "Paldean" };
    const vOpts = allVariantObjs().map((v) => {
      const reg = (v.aspects || []).map((a) => String(a).toLowerCase()).find((a) => ADJ[a]);
      const label = reg ? `${ADJ[reg]} ${v.base}` : `${v.base} ${v.name}`;
      return `<option value="${label.replace(/"/g, "")}">✦ ${v.base} · ${v.name}</option>`;
    }).join("");
    huntList.innerHTML = els.speciesList.innerHTML + vOpts;
  }

  // Party builder move autocomplete (name + type/category label).
  const movesList = document.getElementById("moves-list");
  if (movesList) movesList.innerHTML = MOVES
    .map((m) => `<option value="${m.name}">${m.type} · ${m.category}</option>`).join("");

  // Held-item autocomplete for the party planner.
  const itemsList = document.getElementById("held-items-list");
  if (itemsList) itemsList.innerHTML = HELD_ITEMS.map((i) => `<option value="${i}">`).join("");

  // Populate biome dropdowns: real in-game biomes (forest, steppe…) + spawn categories.
  const biomeOpts = biomeSelectOptions();
  els.spawnBiomeSelect.innerHTML = biomeOpts;
  els.snackBiome.innerHTML = biomeOpts;
  // Default the "near water" toggle to match the initially-selected biome.
  if (els.snackNearWater) els.snackNearWater.checked = biomeWaterShare(els.snackBiome.value) >= 0.5;

  // Populate the 3 PokéSnack seasoning slots: "none" + grouped berries/items.
  // Each option shows the berry's target (type / EV stat / egg group / nature …)
  // so what it does is obvious without opening the summary.
  const optTag = (b) => b.type || b.ev || b.iv || b.nature || (b.eggGroups && b.eggGroups.join("/"))
    || (b.level ? `+${b.level} lv` : "");
  const groups = [...new Set(BERRIES.map((b) => b.group))];
  const seasoningOpts = `<option value="">— none —</option>` + groups.map((g) =>
    `<optgroup label="${g}">` +
    BERRIES.filter((b) => b.group === g).map((b) => {
      const tag = optTag(b);
      return `<option value="${b.id}">${b.name}${tag ? ` — ${tag}` : ""}</option>`;
    }).join("") +
    `</optgroup>`).join("");
  ["snack-s0", "snack-s1", "snack-s2"].forEach((id) => { document.getElementById(id).innerHTML = seasoningOpts; });
  populateSimControls(biomeOpts, seasoningOpts);

  // Legendary calculator target dropdown — grouped by re-spawn tier.
  if (els.legCalcTarget && LEGENDS) {
    els.legCalcTarget.innerHTML = `<option value="">— any legendary (generic 2%) —</option>` +
      LEGENDS.tiers.map((t) => {
        const es = LEGENDS.list.filter((e) => e.tier === t.key);
        return es.length ? `<optgroup label="${t.icon} ${t.label}">` +
          es.map((e) => `<option value="${e.dex}">${legName(e.dex)}</option>`).join("") + `</optgroup>` : "";
      }).join("");
  }

  wire();
  fillConfigInputs();
  renderDex();
  renderForms();
  renderVariants();
  renderLegendary();
  renderLegCalc();
  renderHunt();
  renderFarm();
  renderBoxes();
  renderSnack();
  renderBerries();
  renderParty();
  renderDashboard();
  renderStats();
  const hash = location.hash.replace("#", "");
  if (hash) showTab(hash);
}
boot();
