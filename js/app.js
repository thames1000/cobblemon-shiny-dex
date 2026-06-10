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
  return { mode: "chain", activeDex: null, sessions: {}, finds: [] };
}
// ---- Party builder state ----
const STATS = [["hp", "HP"], ["atk", "Atk"], ["def", "Def"], ["spa", "SpA"], ["spd", "SpD"], ["spe", "Spe"]];
function emptyMember() {
  return {
    dex: null, nature: "", ability: "", moves: ["", "", "", ""],
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
  return { dex: {}, forms: {}, variants: {}, berries: {}, wishlist: [], party: defaultParty(), config: defaultConfig(), hunt: defaultHunt() };
}
let state = freshState();

/* ---------- persistence ---------- */
function normalize() {
  if (!state.dex) state.dex = {};
  if (!state.forms) state.forms = {};
  if (!state.variants) state.variants = {};
  if (!state.berries) state.berries = {};
  // Wishlist: unique, finite dex numbers, in add order.
  const rawWish = Array.isArray(state.wishlist) ? state.wishlist : [];
  const seenWish = new Set();
  state.wishlist = rawWish.map(Number).filter((d) => Number.isFinite(d) && !seenWish.has(d) && seenWish.add(d));
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
      cleanSessions[huntKey(mode, dex)] = {
        mode, dex,
        count: Number.isFinite(s.count) ? Math.max(0, Math.floor(s.count)) : 0,
        startedAt: Number.isFinite(s.startedAt) ? s.startedAt : Date.now(),
      };
    }
  }
  state.hunt.sessions = cleanSessions;
  if (!Array.isArray(state.hunt.finds)) state.hunt.finds = [];
  if (state.hunt.activeDex != null && !Number.isFinite(Number(state.hunt.activeDex))) state.hunt.activeDex = null;
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
  renderDex(); renderForms(); renderVariants(); renderBerries(); renderParty();
  fillConfigInputs(); renderHunt(); renderBoxes(); renderSnack();
  renderDashboard(); renderStats();
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
  el.innerHTML =
    `${have ? `<span class="badge">${shiny ? "✨" : "✓"}</span>` : ""}` +
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
  return { role, nature, evs, ivs, moves: picks.slice(0, 4), ability, why, base: b, bst: c.bst, abilities: c.abilities, hidden: c.hidden };
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

function huntKey(mode, dex) { return `${mode}:${dex}`; }
function activeSession() {
  const h = state.hunt;
  if (h.activeDex == null) return null;
  return h.sessions[huntKey(h.mode, h.activeDex)] || null;
}
function ensureSession(mode, dex) {
  const k = huntKey(mode, dex);
  if (!state.hunt.sessions[k]) {
    state.hunt.sessions[k] = { mode, dex, count: 0, startedAt: Date.now() };
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

  const s = activeSession();
  if (!s || h.activeDex == null) {
    els.huntSprite.removeAttribute("src");
    els.huntSprite.style.visibility = "hidden";
    els.huntTarget.textContent = "No target selected";
    els.huntCount.textContent = "0";
    els.huntOdds.innerHTML = "";
  } else {
    const sp = DEX_BY_NUM[h.activeDex];
    els.huntSprite.src = spriteUrl(h.activeDex, true);
    els.huntSprite.style.visibility = "visible";
    els.huntSprite.alt = sp ? sp.name : "";
    els.huntTarget.textContent = sp ? `${sp.name.replace(/-/g, " ")} · #${String(sp.dex).padStart(4, "0")}` : "";
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
    const name = sp ? sp.name.replace(/-/g, " ") : String(s.dex);
    const isActive = h.mode === s.mode && h.activeDex === s.dex;
    return `<div class="find-row active-hunt${isActive ? " current" : ""}" data-mode="${s.mode}" data-dex="${s.dex}" role="button" tabindex="0" title="Resume this hunt">
      <img src="${spriteUrl(s.dex, true)}" alt="" />
      <span class="find-name">${name}</span>
      <span class="muted">${s.mode} · ${s.count} ${unit[s.mode] || ""}${isActive ? " · current" : ""}</span>
      <button class="ctrl-btn ah-drop" data-mode="${s.mode}" data-dex="${s.dex}" title="Give up this hunt">✕</button>
    </div>`;
  }).join("");
}

function resumeHunt(mode, dex) {
  state.hunt.mode = mode;
  state.hunt.activeDex = dex;
  ensureSession(mode, dex);
  save(); renderHunt();
}
function dropHunt(mode, dex) {
  const k = huntKey(mode, dex);
  delete state.hunt.sessions[k];
  if (state.hunt.mode === mode && state.hunt.activeDex === dex) state.hunt.activeDex = null;
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

function setMode(mode) { state.hunt.mode = mode; save(); renderHunt(); }
function bumpCount(delta) {
  const h = state.hunt;
  if (h.activeDex == null) return;
  const s = ensureSession(h.mode, h.activeDex);
  s.count = Math.max(0, s.count + delta);
  save(); renderHunt(); refreshDashboard();
}
function loadTarget(raw) {
  const q = String(raw || "").trim().toLowerCase().replace(/^#/, "");
  if (!q) return;
  let sp = SPECIES.find((s) => s.name === q);
  if (!sp && /^\d+$/.test(q)) sp = DEX_BY_NUM[Number(q)];
  if (!sp) sp = SPECIES.find((s) => s.name.startsWith(q));
  if (!sp) { alert(`No species matching "${raw}".`); return; }
  state.hunt.activeDex = sp.dex;
  ensureSession(state.hunt.mode, sp.dex);
  save(); renderHunt();
}
// The pool 🎲 Surprise me draws from, per the chosen scope.
//  smart    – wishlist (un-caught) → not-yet-shiny → anything  (the default)
//  unshiny  – anything you haven't shiny-caught yet
//  all      – literally any species
function randomPool(scope) {
  const hasShiny = (st) => st === "shiny" || st === "boxed";
  switch (scope) {
    case "unshiny": return SPECIES.filter((sp) => !hasShiny(dexState(sp.dex)));
    case "all": return SPECIES.slice();
    case "smart":
    default: {
      const notDone = (sp) => !hasShiny(dexState(sp.dex));
      const wished = state.wishlist.map((d) => DEX_BY_NUM[d]).filter((sp) => sp && notDone(sp));
      if (wished.length) return wished;
      const fresh = SPECIES.filter(notDone);
      return fresh.length ? fresh : SPECIES.slice();
    }
  }
}
// Bored? Roll a random target from the chosen scope.
function randomHuntTarget() {
  const pool = randomPool(state.config.randomScope || "smart");
  if (!pool.length) { alert("Nothing matches that random filter yet — try a different one."); return; }
  const sp = pool[Math.floor(Math.random() * pool.length)];
  state.hunt.activeDex = sp.dex;
  ensureSession(state.hunt.mode, sp.dex);
  els.huntInput.value = sp.name;
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
  const s = ensureSession(h.mode, h.activeDex);
  // Stamp the luck (vs the odds in effect right now) so it stays accurate even
  // if the pack's odds settings change later.
  const luck = computeLuck(h.mode, s.count).p;
  state.hunt.finds.push({ dex: h.activeDex, name: sp ? sp.name : String(h.activeDex), mode: h.mode, count: s.count, foundAt: Date.now(), luck });
  if (boxed) state.dex[String(h.activeDex)] = "boxed";
  else if (dexState(h.activeDex) !== "boxed") state.dex[String(h.activeDex)] = "shiny";
  // Reset this session's count for a fresh hunt.
  s.count = 0;
  save(); renderHunt(); renderDex(); renderBoxes(); refreshDashboard(); refreshStats();
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
  ensureSession(mode, huntStartDex);
  closeHuntStart();
  save(); renderHunt();
  showTab("hunt");
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
function findLuckP(f) {
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
// Shared "recent finds" row (Home + Hunt + Stats), now with a luck chip.
function findRowHtml(f) {
  const d = new Date(f.foundAt);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const unit = f.mode === "breeding" ? " eggs" : f.mode === "chain" ? " KOs" : "";
  const p = findLuckP(f);
  const b = luckBadge(p);
  return `<div class="find-row"><img src="${spriteUrl(f.dex, true)}" alt="" />` +
    `<span class="find-name">${(f.name || "").replace(/-/g, " ")}</span>` +
    `<span class="luck-chip ${b.cls}" title="Luckier than ${Math.round(p * 100)}% of equivalent hunts">${b.txt}</span>` +
    `<span class="muted">${f.mode} · ${f.count}${unit} · ${date}</span></div>`;
}

/* ---------- wishlist (#8) ---------- */
function toggleWishlist(dex) {
  const i = state.wishlist.indexOf(dex);
  if (i >= 0) state.wishlist.splice(i, 1); else state.wishlist.push(dex);
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
  renderDashHunt();
  renderDashProgress();
  renderDashWishlist();
  renderDashGaps();
  renderDashFinds();
}

function renderDashWishlist() {
  const el = document.getElementById("dash-wishlist");
  if (!el) return;
  const list = state.wishlist.map((d) => DEX_BY_NUM[d]).filter(Boolean);
  if (!list.length) {
    el.innerHTML = `<h2>★ Wishlist</h2><p class="hint">Star Pokémon on the Dex (tap ☆) to pin your hunt goals here. 🎲 Surprise me favours them.</p>`;
    return;
  }
  el.innerHTML =
    `<h2>★ Wishlist <span class="muted">— ${list.length}</span></h2>` +
    `<div class="dash-gaps-row">` + list.map((sp) => {
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
    }).join("") + `</div>`;
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
    `<h2>Recent finds <span class="muted">— ${finds.length} total</span></h2>` +
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

function renderStatsSummary() {
  const el = document.getElementById("stats-summary");
  if (!el) return;
  const finds = state.hunt.finds;
  const c = dexCounts();
  if (!finds.length) {
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
  const byMode = { chain: 0, breeding: 0, encounter: 0 };
  let totalEnc = 0, best = null, worst = null;
  for (const f of finds) {
    byMode[f.mode] = (byMode[f.mode] || 0) + 1;
    totalEnc += Number(f.count) || 0;
    const p = findLuckP(f);
    if (!best || p > best.p) best = { f, p };
    if (!worst || p < worst.p) worst = { f, p };
  }
  const avg = Math.round(totalEnc / finds.length);
  el.innerHTML =
    `<h2>Stats <span class="muted">— ${finds.length} shiny logged</span></h2>` +
    `<div class="dash-stat-line">` +
      `<span class="stat"><b>${c.shiny}</b>/${c.total} shiny</span>` +
      `<span class="stat">📦 boxed <b>${c.boxed}</b></span>` +
      `<span class="stat">caught <b>${c.caught}</b></span>` +
    `</div>` +
    `<div class="dash-stat-line">` +
      `<span class="stat">total tracked <b>${totalEnc.toLocaleString()}</b></span>` +
      `<span class="stat">avg / shiny <b>${avg.toLocaleString()}</b></span>` +
      `<span class="stat">chain <b>${byMode.chain}</b> · breed <b>${byMode.breeding}</b> · enc <b>${byMode.encounter}</b></span>` +
    `</div>` +
    `<div class="stats-luck">` +
      `<div class="luck-line">🍀 Luckiest: ${findRef(best.f)}</div>` +
      `<div class="luck-line">💀 Unluckiest: ${findRef(worst.f)}</div>` +
    `</div>`;
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
  const totalEnc = finds.reduce((s, f) => s + (Number(f.count) || 0), 0);
  const gensComplete = Object.keys(c.genTot).filter((g) => (c.genBox[g] || 0) === c.genTot[g]).length;
  const bestLuck = finds.reduce((m, f) => Math.max(m, findLuckP(f)), 0);
  const longest = finds.reduce((m, f) => Math.max(m, Number(f.count) || 0), 0);
  const M = [
    { icon: "✨", title: "First Shiny", desc: "Log your first shiny", done: finds.length >= 1, prog: `${finds.length}` },
    { icon: "🔟", title: "Perfect Ten", desc: "10 shinies logged", done: finds.length >= 10, prog: `${finds.length}/10` },
    { icon: "💯", title: "Centurion", desc: "100 shinies logged", done: finds.length >= 100, prog: `${finds.length}/100` },
    { icon: "🌟", title: "Shiny Charm", desc: "250 shinies logged", done: finds.length >= 250, prog: `${finds.length}/250` },
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
function buildBiomeIndex() {
  BIOME_INDEX = {};
  for (const dex in SPAWNS) {
    for (const e of SPAWNS[dex]) {
      for (const b of e.b) {
        if (PSEUDO_BIOMES.has(b)) continue;
        (BIOME_INDEX[b] = BIOME_INDEX[b] || []).push({ dex: Number(dex), entry: e });
      }
    }
  }
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
  const entries = (SPAWNS[dex] || []).filter((e) => (e.b || []).includes(biome));
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
      return `<div class="spawn-row">
      <div class="spawn-biomes">${e.f ? formChip(e.f) : ""}${loc}</div>
      ${meta || e.r ? `<div class="spawn-meta">${rarityChip(e.r)} <span class="muted">${meta}</span></div>` : ""}
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
  const list = (BIOME_INDEX[biome] || [])
    .sort((a, b) => RARITY_ORDER[a.entry.r] - RARITY_ORDER[b.entry.r] || (b.entry.w || 0) - (a.entry.w || 0));
  if (!list.length) return `<div class="card"><p class="hint">Nothing indexed for that biome.</p></div>`;
  const cards = list.map(({ dex, entry }) => {
    const sp = DEX_BY_NUM[dex];
    return `<div class="mon" data-dex="${dex}" title="${entry.f ? entry.f + " · " : ""}${entryDetail(entry)}">
      <span class="badge r-${entry.r}">${entry.r[0].toUpperCase()}</span>
      <img loading="lazy" src="${spriteUrl(dex)}" alt="${sp ? sp.name : dex}"/>
      <div class="dexno">#${String(dex).padStart(4, "0")}</div>
      <div class="nm">${sp ? sp.name.replace(/-/g, " ") : dex}</div>
      ${entry.f ? `<div class="form-tag">✦ ${entry.f}</div>` : ""}</div>`;
  }).join("");
  return `<div class="card"><h2 style="text-transform:capitalize">${biome} <span class="muted" style="font-weight:400">· ${list.length} spawns</span></h2></div>
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

// Official Poké Snack rarity-bucket odds at seasoning tiers 0, 3 and 10 (Cobblemon Wiki).
// Intermediate tiers are interpolated; this is an approximation of the in-game roll.
const TIER_TABLE = {
  0:  { common: 0.862,  uncommon: 0.1028, rare: 0.0251, "ultra-rare": 0.0101 },
  3:  { common: 0.5937, uncommon: 0.2131, rare: 0.1235, "ultra-rare": 0.0697 },
  10: { common: 0.2848, uncommon: 0.2408, rare: 0.2732, "ultra-rare": 0.2013 },
};
const BUCKETS = ["common", "uncommon", "rare", "ultra-rare"];
function bucketOdds(tier) {
  const t = Math.max(0, Math.min(10, tier));
  const [lo, hi] = t <= 3 ? [0, 3] : [3, 10];
  const f = (t - lo) / (hi - lo);
  const out = {};
  for (const b of BUCKETS) out[b] = TIER_TABLE[lo][b] + (TIER_TABLE[hi][b] - TIER_TABLE[lo][b]) * f;
  return out;
}

function selectedSeasonings() {
  return ["snack-s0", "snack-s1", "snack-s2"]
    .map((id) => document.getElementById(id).value)
    .filter(Boolean)
    .map((id) => BERRY_BY_ID[id])
    .filter(Boolean);
}

// ×10 per selected type / egg-group seasoning the species matches. Multipliers
// stack across seasonings, mirroring Cobblemon's bait math. EV-yield berries are
// NOT a multiplier — they hard-filter the pool (see evMatch / computeAttraction).
function snackMult(sp, seasonings) {
  if (!sp) return 1;
  let m = 1;
  for (const s of seasonings) {
    if (s.type && sp.types.includes(s.type)) m *= 10;
    if (s.eggGroups && sp.eggGroups && s.eggGroups.some((g) => sp.eggGroups.includes(g))) m *= 10;
  }
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
  const pool = BIOME_INDEX[biome] || [];
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
    wrap.innerHTML = `<p class="hint">No seasonings yet — the list below shows the biome's <em>natural</em> spawn
      distribution. Add a <strong>type berry</strong> (e.g. Occa → Fire) to bias attraction, or a rarity item
      (Golden Apple, Enchanted Golden Apple…) to lure rarer Pokémon.</p>`;
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
// array [{dex, p, boosted}] where p sums to 1 across the pool (empty if no pool).
function computeAttraction(biome, seasonings, nearWater = true) {
  const pool = BIOME_INDEX[biome] || [];
  if (!pool.length) return [];
  const odds = bucketOdds(seasonings.reduce((a, s) => a + (s.rarityTier || 0), 0));

  // Bucket each spawn entry, weighted by spawn weight × type/egg multiplier.
  // EV-yield seasonings gate the pool: non-matching species are removed entirely.
  // Water-only spawns are gated on placement: dropped if the snack isn't near water.
  const evReqs = evRequirements(seasonings);
  const buckets = { common: [], uncommon: [], rare: [], "ultra-rare": [] };
  for (const { dex, entry } of pool) {
    if (!buckets[entry.r]) continue;
    if (!nearWater && needsWater(entry)) continue;      // dry land — aquatic spawns can't roll
    const sp = DEX_BY_NUM[dex];
    if (!passesEvGate(sp, evReqs)) continue;            // forced out — can't be lured
    const mult = snackMult(sp, seasonings);
    const w = (entry.w || 0) * mult;   // weight-0 spawns don't roll, so they can't be lured
    if (w <= 0) continue;
    // A type/egg ×10 OR surviving an EV gate both mean the snack deliberately favours this species.
    buckets[entry.r].push({ dex, w, boosted: mult > 1 || evReqs.length > 0 });
  }
  // Only buckets with entries carry probability mass; renormalise across those present.
  const present = BUCKETS.filter((b) => buckets[b].length);
  const oddsSum = present.reduce((a, b) => a + odds[b], 0) || 1;

  const attraction = {}; // dex -> { p, boosted }
  for (const b of present) {
    const tot = buckets[b].reduce((a, x) => a + x.w, 0) || 1;
    const bucketProb = odds[b] / oddsSum;
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
  const pool = BIOME_INDEX[biome] || [];
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

function bestSnackFor(dex, allowEGA) {
  const sp = DEX_BY_NUM[dex];
  if (!sp) return null;
  const biomes = [...new Set((SPAWNS[dex] || []).flatMap((e) => e.b))].filter((b) => BIOME_INDEX[b]);
  if (!biomes.length) return null;
  const combos = multisetCombos(relevantSeasonings(sp, allowEGA), 3);
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
    <div class="plan-row"><span>Biome</span><b style="text-transform:capitalize">${plan.biome}</b></div>
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
  const without = bestSnackFor(sp.dex, false);
  if (!without) {
    els.snackBestOut.innerHTML = `<p class="hint">${sp.name.replace(/-/g, " ")} has no natural Poké Snack spawn in base
      Cobblemon, so a snack can't lure it.</p>`;
    return;
  }
  const baseRate = Number(els.snackBaseRate.value) || state.config.baseShinyRate;
  const withEGA = bestSnackFor(sp.dex, true);
  const usesEGA = withEGA && withEGA.combo.some((b) => b.id === "enchanted-golden-apple");
  const egaNote = !usesEGA
    ? `<p class="hint">An Enchanted Golden Apple doesn't beat the budget plan for ${sp.name.replace(/-/g, " ")} — it's
       common enough that the rarity shift costs more than the shiny boost gains, so both plans match.</p>` : "";
  els.snackBestOut.innerHTML =
    `<div class="find-row" style="border:0;padding:0 0 8px"><img src="${spriteUrl(sp.dex, true)}" alt=""/>
       <span class="find-name">Best plan · ${sp.name.replace(/-/g, " ")}</span></div>` +
    `<div class="snack-best-grid">` +
      planCard("Budget · no EGA", without, sp, baseRate) +
      planCard("Premium · with EGA", withEGA, sp, baseRate) +
    `</div>${egaNote}` +
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
  const odds = bucketOdds(o.seasonings.reduce((a, s) => a + (s.rarityTier || 0), 0));
  const evReqs = evRequirements(o.seasonings);
  const buckets = { common: [], uncommon: [], rare: [], "ultra-rare": [] };
  const excl = { tall: 0, near: 0, base: 0, y: 0, time: 0, weather: 0 };
  for (const dex in SIM.spawns) {
    const sp = DEX_BY_NUM[dex];
    const hb = SIM.hitbox[dex];
    for (const e of SIM.spawns[dex]) {
      if (!buckets[e.r] || !e.w) continue;
      if (!(e.b || []).includes(o.biome)) continue;
      if (e.y && ((e.y[0] != null && o.y < e.y[0]) || (e.y[1] != null && o.y > e.y[1]))) { excl.y++; continue; }
      if (hb && Math.ceil(hb[1]) > o.height) { excl.tall++; continue; }
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
  const present = BUCKETS.filter((b) => buckets[b].length);
  const oddsSum = present.reduce((a, b) => a + odds[b], 0) || 1;
  const at = {};
  for (const b of present) {
    const tot = buckets[b].reduce((a, x) => a + x.w, 0) || 1;
    const bp = odds[b] / oddsSum;
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

function renderSim() {
  if (!els.simBiome) return;
  const o = {
    biome: els.simBiome.value,
    y: Number(els.simY.value),
    height: Number(els.simHeight.value) || 1,
    time: els.simTime.value,
    weather: els.simWeather.value,
    baseBlock: els.simBase.value,
    items: simPlacedItems(),
    seasonings: simSeasonings(),
  };
  const { ranked, excl } = computeSpawns(o);

  const blocked = [];
  if (excl.tall) blocked.push(`${excl.tall} too tall for ${o.height} block${o.height > 1 ? "s" : ""}`);
  if (excl.near) blocked.push(`${excl.near} need a block you haven't placed`);
  if (excl.y) blocked.push(`${excl.y} out of Y range`);
  if (excl.base) blocked.push(`${excl.base} need a specific spawn-area block`);
  if (excl.time) blocked.push(`${excl.time} wrong time`);
  if (excl.weather) blocked.push(`${excl.weather} wrong weather`);
  els.simSummary.innerHTML = `<div class="card"><p class="hint" style="margin:0">
    <b>${ranked.length}</b> species can spawn at Y ${o.y} in <b style="text-transform:capitalize">${o.biome}</b>
    with <b>${o.height}</b> blocks of headroom${o.items.size ? ` and ${o.items.size} placed block${o.items.size > 1 ? "s" : ""}` : ""}.
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

/* ---------- tabs ---------- */
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
  if (name === "boxes") renderBoxes(); // refresh in case dex changed on another tab
  if (name === "home") renderDashboard();
  if (name === "stats") renderStats();
  if (name === "sim") renderSim();
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
      renderDex(); renderForms(); renderVariants(); renderBerries(); renderParty();
      fillConfigInputs(); renderHunt(); renderBoxes(); renderSnack();
      renderDashboard(); renderStats();
      const dexN = Object.keys(state.dex).length;
      const varN = Object.keys(state.variants).length;
      const berryN = Object.keys(state.berries).length;
      const huntN = Object.values(state.hunt.sessions || {}).filter((s) => s && s.count > 0).length;
      alert(`Imported — ${dexN} dex, ${varN} variants, ${berryN} berries, ${huntN} active hunts.`);
    } catch (e) { alert("Import failed: " + e.message); }
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
    huntRandomScope: document.getElementById("hunt-random-scope"),
    speciesList: document.getElementById("species-list"),
    huntFinds: document.getElementById("hunt-finds"),
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
    simTime: document.getElementById("sim-time"),
    simWeather: document.getElementById("sim-weather"),
    simBase: document.getElementById("sim-base"),
    simItems: document.getElementById("sim-items"),
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

function wire() {
  document.getElementById("tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (t) showTab(t.dataset.tab);
  });

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
      const gapHunt = e.target.closest(".dash-gap-hunt");
      if (gapHunt) { e.stopPropagation(); openHuntStart(Number(gapHunt.dataset.dex)); return; }
      const gapBox = e.target.closest(".dash-gap-box");
      if (gapBox) { e.stopPropagation(); markBoxed(Number(gapBox.dataset.dex)); return; }
      const wlStar = e.target.closest(".dash-wl-star");
      if (wlStar) { e.stopPropagation(); toggleWishlist(Number(wlStar.dataset.dex)); renderDex(); refreshDashboard(); return; }
      const gap = e.target.closest(".dash-gap[data-dex]");
      if (gap) { showTab("boxes"); jumpToSpecies(DEX_BY_NUM[Number(gap.dataset.dex)]); return; }
    });
    homePanel.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const gap = e.target.closest(".dash-gap[data-dex]");
      if (gap) { e.preventDefault(); showTab("boxes"); jumpToSpecies(DEX_BY_NUM[Number(gap.dataset.dex)]); }
    });
  }

  // Dex grid: 🎯 starts a hunt; otherwise click cycles forward, right-click back.
  els.dexGrid.addEventListener("click", (e) => {
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
  els.huntRandomScope.addEventListener("change", () => { state.config.randomScope = els.huntRandomScope.value; save(); });
  els.huntActive.addEventListener("click", (e) => {
    const drop = e.target.closest(".ah-drop");
    if (drop) { e.stopPropagation(); dropHunt(drop.dataset.mode, Number(drop.dataset.dex)); return; }
    const row = e.target.closest(".active-hunt");
    if (row) resumeHunt(row.dataset.mode, Number(row.dataset.dex));
  });
  els.huntActive.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest(".active-hunt");
    if (row) { e.preventDefault(); resumeHunt(row.dataset.mode, Number(row.dataset.dex)); }
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
    [els.simBiome, els.simY, els.simHeight, els.simTime, els.simWeather, els.simBase,
      ...["sim-s0", "sim-s1", "sim-s2"].map((id) => document.getElementById(id))]
      .forEach((el) => el && el.addEventListener("change", renderSim));
    els.simY.addEventListener("input", renderSim);
    els.simHeight.addEventListener("input", renderSim);
    els.simItems.addEventListener("change", renderSim);
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
  els.resetAll.addEventListener("click", () => {
    if (confirm("Erase ALL progress? Export first if unsure.")) {
      state = freshState();
      save(); renderDex(); renderForms(); renderVariants(); renderBerries(); renderParty();
      fillConfigInputs(); renderHunt(); renderBoxes(); renderSnack(); renderDashboard(); renderStats();
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
    if (d.state === "synced" && d.at) lastSyncAt = d.at;
    setSyncBadge(d.state, d.message);
    showAccountView();
  });
  showAccountView();
  const [sp, fm, spawns, berries, variants, berryGuide, moves, coach] = await Promise.all([
    fetch("js/data/species.json").then((r) => r.json()),
    fetch("js/data/forms.json").then((r) => r.json()),
    fetch("js/data/spawns.json").then((r) => r.json()).catch(() => ({})),
    fetch("js/data/berries.json").then((r) => r.json()).catch(() => []),
    fetch("js/data/variants.json").then((r) => r.json()).catch(() => ({ regional: { alolan: [], galarian: [], hisuian: [], paldean: [] }, cosmetic: [], unown: [], cobblemon: [] })),
    fetch("js/data/berry-guide.json").then((r) => r.json()).catch(() => []),
    fetch("js/data/moves.json").then((r) => r.json()).catch(() => []),
    fetch("js/data/coach.json").then((r) => r.json()).catch(() => ({})),
  ]);
  SPECIES = sp;
  MOVES = moves;
  MOVE_BY_NAME = {};
  MOVES.forEach((m) => (MOVE_BY_NAME[m.name] = m));
  COACH = coach;
  FORMS = { mega: fm.mega, primal: fm.primal, gmax: fm.gmax };
  VARIANTS = variants;
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
  SIM = await fetch("js/data/sim-spawns.json").then((r) => r.json())
    .catch(() => ({ spawns: {}, items: [], baseBlocks: [], hitbox: {} }));

  // Populate the target datalist once. Put the name in the label too, so browsers
  // that filter suggestions by the label (not the value) still match name typing.
  els.speciesList.innerHTML = SPECIES
    .map((s) => `<option value="${s.name}">#${String(s.dex).padStart(4, "0")} ${s.name}</option>`).join("");

  // Party builder move autocomplete (name + type/category label).
  const movesList = document.getElementById("moves-list");
  if (movesList) movesList.innerHTML = MOVES
    .map((m) => `<option value="${m.name}">${m.type} · ${m.category}</option>`).join("");

  // Populate biome dropdown (sorted, with spawn counts).
  const biomeOpts = Object.keys(BIOME_INDEX).sort()
    .map((b) => `<option value="${b}">${b} (${BIOME_INDEX[b].length})</option>`).join("");
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

  wire();
  fillConfigInputs();
  renderDex();
  renderForms();
  renderVariants();
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
