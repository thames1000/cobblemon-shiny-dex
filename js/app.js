/* ShinyDex HQ — Cobblemon x Create shiny living dex tracker.
 *
 * Vanilla JS PWA (no build step) so it deploys to GitHub Pages as static files
 * and works offline. Progress is manual and lives in localStorage; reference
 * data (species.json, forms.json) is bundled and read-only.
 */

const STORAGE_KEY = "shinydex-hq-v1";
const SPRITE_BASE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon";

// Dex state cycle. Right-click steps back.
const DEX_STATES = ["none", "seen", "caught", "shiny", "boxed"];
const STATE_BADGE = { seen: "S", caught: "C", shiny: "✨", boxed: "📦" };

let SPECIES = [];   // [{dex,name,types,gen}]
let FORMS = null;   // {mega:[],primal:[],gmax:[]}
let VARIANTS = null; // {regional:{alolan,galarian,hisuian,paldean}, cosmetic:[]}
let DEX_BY_NUM = {}; // dex -> species

// Pack defaults (Cobblemon + Unchained + Cobbreeding). All editable in-app.
function defaultConfig() {
  return {
    baseShinyRate: 8192,
    unchainedThresholds: [[100, 1], [300, 2], [500, 3]], // [koStreak, +shinyChances]
    masudaMultiplier: 4,
  };
}
function defaultHunt() {
  return { mode: "chain", activeDex: null, sessions: {}, finds: [] };
}
function freshState() {
  return { dex: {}, forms: {}, variants: {}, config: defaultConfig(), hunt: defaultHunt() };
}
let state = freshState();

/* ---------- persistence ---------- */
function normalize() {
  if (!state.dex) state.dex = {};
  if (!state.forms) state.forms = {};
  if (!state.variants) state.variants = {};
  state.config = Object.assign(defaultConfig(), state.config || {});
  state.hunt = Object.assign(defaultHunt(), state.hunt || {});
  if (!state.hunt.sessions) state.hunt.sessions = {};
  if (!Array.isArray(state.hunt.finds)) state.hunt.finds = [];
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (d && typeof d === "object") state = Object.assign(freshState(), d);
  } catch (_) { /* keep defaults */ }
  normalize();
}
function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

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
  el.innerHTML =
    `${STATE_BADGE[st] ? `<span class="badge">${STATE_BADGE[st]}</span>` : ""}` +
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
    ...VARIANTS.regional.hisuian, ...VARIANTS.regional.paldean, ...VARIANTS.cosmetic];
}
function variantCard(v) {
  const have = !!state.variants[v.id];
  const el = document.createElement("div");
  el.className = `mon ${have ? "f-unlocked" : "f-locked"}`;
  el.dataset.variant = v.id;
  el.title = `${v.base} · ${v.name}`;
  el.innerHTML =
    `${have ? `<span class="badge">✓</span>` : ""}` +
    `<img loading="lazy" src="${spriteUrl(v.dex, false)}" alt="${v.base} ${v.name}" />` +
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
  renderVariantsStats();
}
function renderVariantsStats() {
  const all = allVariants();
  const have = all.filter((v) => state.variants[v.id]).length;
  const pct = all.length ? ((have / all.length) * 100).toFixed(0) : 0;
  const regional = [...VARIANTS.regional.alolan, ...VARIANTS.regional.galarian,
    ...VARIANTS.regional.hisuian, ...VARIANTS.regional.paldean];
  const regHave = regional.filter((v) => state.variants[v.id]).length;
  els.variantsStats.innerHTML =
    `<span class="stat"><b>${have}</b>/${all.length} caught (${pct}%)</span>` +
    `<div class="bar"><i style="width:${pct}%"></i></div>` +
    `<span class="stat">Regional ${regHave}/${regional.length}</span>` +
    `<span class="stat">Cosmetic ${VARIANTS.cosmetic.filter((v) => state.variants[v.id]).length}/${VARIANTS.cosmetic.length}</span>`;
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
  renderFinds();
}

function renderFinds() {
  const wrap = els.huntFinds;
  const finds = state.hunt.finds;
  if (!finds.length) {
    wrap.innerHTML = `<p class="hint">No shinies logged yet — go get one. ✨</p>`;
    return;
  }
  wrap.innerHTML = finds.slice().reverse().map((f) => {
    const d = new Date(f.foundAt);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return `<div class="find-row">
      <img src="${spriteUrl(f.dex, true)}" alt="" />
      <span class="find-name">${(f.name || "").replace(/-/g, " ")}</span>
      <span class="muted">${f.mode} · ${f.count}${f.mode === "breeding" ? " eggs" : f.mode === "chain" ? " KOs" : ""} · ${date}</span>
    </div>`;
  }).join("");
}

function setMode(mode) { state.hunt.mode = mode; save(); renderHunt(); }
function bumpCount(delta) {
  const h = state.hunt;
  if (h.activeDex == null) return;
  const s = ensureSession(h.mode, h.activeDex);
  s.count = Math.max(0, s.count + delta);
  save(); renderHunt();
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
function foundShiny() {
  const h = state.hunt;
  if (h.activeDex == null) return;
  const sp = DEX_BY_NUM[h.activeDex];
  const s = ensureSession(h.mode, h.activeDex);
  state.hunt.finds.push({ dex: h.activeDex, name: sp ? sp.name : String(h.activeDex), mode: h.mode, count: s.count, foundAt: Date.now() });
  // Promote dex entry to at least Shiny (don't downgrade a Boxed one).
  const cur = dexState(h.activeDex);
  if (cur !== "boxed") state.dex[String(h.activeDex)] = "shiny";
  // Reset this session's count for a fresh hunt.
  s.count = 0;
  save(); renderHunt(); renderDex();
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

function buildBiomeIndex() {
  BIOME_INDEX = {};
  for (const dex in SPAWNS) {
    for (const e of SPAWNS[dex]) {
      for (const b of e.b) {
        (BIOME_INDEX[b] = BIOME_INDEX[b] || []).push({ dex: Number(dex), entry: e });
      }
    }
  }
}

function rarityChip(r) { return `<span class="r-chip r-${r}">${r}</span>`; }

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

function renderSpawnByMon(dex) {
  const sp = DEX_BY_NUM[dex];
  const rows = SPAWNS[dex];
  if (!rows) {
    return `<div class="card"><div class="find-row"><img src="${spriteUrl(dex)}" alt=""/>
      <span class="find-name">${sp ? sp.name.replace(/-/g, " ") : "#" + dex}</span></div>
      <p class="hint">No wild spawn in Cobbleverse. Obtained via evolution, breeding, a fossil/craft
      (e.g. Type: Null, Melmetal, Gholdengo), trade, or a special event.</p></div>`;
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
        ? e.b.map((b) => `<span class="biome-chip" data-biome="${b}">${b}</span>`).join("")
        : e.st ? e.st.map((s) => `<span class="struct-chip">🏛 ${s}</span>`).join("")
        : e.px ? e.px.map((p) => `<span class="struct-chip">📍 ${p}</span>`).join("")
        : `<span class="muted">special / event</span>`;
      return `<div class="spawn-row">
      <div class="spawn-biomes">${loc}</div>
      <div class="spawn-meta">${rarityChip(e.r)} <span class="muted">${entryDetail(e)}</span></div>
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
    return `<div class="mon" data-dex="${dex}" title="${entryDetail(entry)}">
      <span class="badge r-${entry.r}">${entry.r[0].toUpperCase()}</span>
      <img loading="lazy" src="${spriteUrl(dex)}" alt="${sp ? sp.name : dex}"/>
      <div class="dexno">#${String(dex).padStart(4, "0")}</div>
      <div class="nm">${sp ? sp.name.replace(/-/g, " ") : dex}</div></div>`;
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
 * *which species* shows up — type, egg-group and EV-yield berries (each ×10 to a
 * matching species) plus rarity-tier boosts (shift the common→ultra-rare bucket
 * odds). The remaining seasonings (shiny, level, IV, nature, gender, ability) tune
 * the *traits* of who's attracted, not which species, so they're surfaced in the
 * summary but don't re-rank the list. */
let BERRIES = [];        // [{id,name,group,effect,type?,rarityTier?,shiny?,...}]
let BERRY_BY_ID = {};

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

// ×10 per selected seasoning the species matches (type / egg group / EV yield).
// Multipliers stack across seasonings, mirroring Cobblemon's bait math.
function snackMult(sp, seasonings) {
  if (!sp) return 1;
  let m = 1;
  for (const s of seasonings) {
    if (s.type && sp.types.includes(s.type)) m *= 10;
    if (s.eggGroups && sp.eggGroups && s.eggGroups.some((g) => sp.eggGroups.includes(g))) m *= 10;
    if (s.ev && sp.ev && sp.ev.includes(s.ev)) m *= 10;
  }
  return m;
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
  if (evs.length) head.push(`<span class="snack-stat">EV yield ${evs.map(typeChip).join(" ")}</span>`);
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
function computeAttraction(biome, seasonings) {
  const pool = BIOME_INDEX[biome] || [];
  if (!pool.length) return [];
  const odds = bucketOdds(seasonings.reduce((a, s) => a + (s.rarityTier || 0), 0));

  // Bucket each spawn entry, weighted by spawn weight × type/egg/EV multiplier.
  const buckets = { common: [], uncommon: [], rare: [], "ultra-rare": [] };
  for (const { dex, entry } of pool) {
    if (!buckets[entry.r]) continue;
    const mult = snackMult(DEX_BY_NUM[dex], seasonings);
    const w = (entry.w || 0) * mult;   // weight-0 spawns don't roll, so they can't be lured
    if (w <= 0) continue;
    buckets[entry.r].push({ dex, w, boosted: mult > 1 });
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

function renderSnackResults(ranked) {
  if (!ranked.length) {
    els.snackResults.innerHTML = `<div class="card"><p class="hint">No spawn data indexed for this biome.</p></div>`;
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
  els.snackResults.innerHTML = `<div class="card snack-list">${rows}</div>${more}`;
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

function renderSnack() {
  if (!els.snackBiome) return;
  const biome = els.snackBiome.value;
  const seasonings = selectedSeasonings();
  snackRanked = computeAttraction(biome, seasonings);
  renderSnackSummary(seasonings);
  renderSnackResults(snackRanked);
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
  ["snack-s0", "snack-s1", "snack-s2"].forEach((s, i) => { document.getElementById(s).value = ids[i] || ""; });
  snackTarget = String(dex);
  renderSnack();
  els.snackTarget.value = String(dex);
  renderSnackShiny(selectedSeasonings());
  els.snackBiome.scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ---------- tabs ---------- */
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
  if (name === "boxes") renderBoxes(); // refresh in case dex changed on another tab
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
      renderDex(); renderForms(); renderVariants(); fillConfigInputs(); renderHunt(); renderBoxes();
      alert("Imported.");
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
    speciesList: document.getElementById("species-list"),
    huntFinds: document.getElementById("hunt-finds"),
    cfgBase: document.getElementById("cfg-base"),
    cfgThresholds: document.getElementById("cfg-thresholds"),
    cfgMasuda: document.getElementById("cfg-masuda"),
    spawnInput: document.getElementById("spawn-input"),
    spawnBiomeSelect: document.getElementById("spawn-biome-select"),
    spawnResults: document.getElementById("spawn-results"),
    snackBiome: document.getElementById("snack-biome"),
    snackSummary: document.getElementById("snack-summary"),
    snackBaseRate: document.getElementById("snack-base-rate"),
    snackTarget: document.getElementById("snack-target"),
    snackShinyOut: document.getElementById("snack-shiny-out"),
    snackBestInput: document.getElementById("snack-best-input"),
    snackBestOut: document.getElementById("snack-best-out"),
    snackResults: document.getElementById("snack-results"),
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
  });
}

function wire() {
  document.getElementById("tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (t) showTab(t.dataset.tab);
  });

  // Dex grid: click cycles forward, right-click steps back.
  els.dexGrid.addEventListener("click", (e) => {
    const card = e.target.closest(".mon");
    if (!card) return;
    cycleDex(Number(card.dataset.dex), false);
    refreshCard(card, Number(card.dataset.dex));
  });
  els.dexGrid.addEventListener("contextmenu", (e) => {
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
    const have = !state.variants[id];
    if (have) state.variants[id] = true; else delete state.variants[id];
    save();
    card.classList.toggle("f-unlocked", have);
    card.classList.toggle("f-locked", !have);
    const badge = card.querySelector(".badge");
    if (have && !badge) card.insertAdjacentHTML("afterbegin", `<span class="badge">✓</span>`);
    if (!have && badge) badge.remove();
    renderVariantsStats();
  });
  els.variantSearch.addEventListener("input", renderVariants);

  els.dexSearch.addEventListener("input", renderDex);
  els.dexGen.addEventListener("change", renderDex);
  els.dexFilter.addEventListener("change", renderDex);

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
  document.getElementById("hunt-found").addEventListener("click", foundShiny);
  document.getElementById("hunt-load").addEventListener("click", () => loadTarget(els.huntInput.value));
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
  els.snackBiome.addEventListener("change", renderSnack);
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

  // Farm tab
  ["farmTrees", "farmGrowth", "farmYield", "farmPerBall", "farmTarget"].forEach((k) =>
    els[k].addEventListener("input", renderFarmApricorn));
  ["farmOdds", "farmRate"].forEach((k) => els[k].addEventListener("input", renderFarmShiny));
  document.querySelectorAll(".quick-odds").forEach((b) =>
    b.addEventListener("click", () => quickOdds(b.dataset.odds)));

  // Spacebar = +1 while on the Hunt tab (and not typing in a field).
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    const onHunt = document.getElementById("panel-hunt").classList.contains("active");
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (onHunt && !typing) { e.preventDefault(); bumpCount(1); }
  });

  els.exportBtn.addEventListener("click", exportData);
  els.importBtn.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", (e) => { if (e.target.files[0]) importData(e.target.files[0]); });
  els.resetAll.addEventListener("click", () => {
    if (confirm("Erase ALL progress? Export first if unsure.")) {
      state = freshState();
      save(); renderDex(); renderForms(); renderVariants(); fillConfigInputs(); renderHunt(); renderBoxes();
    }
  });
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
  const [sp, fm, spawns, berries, variants] = await Promise.all([
    fetch("js/data/species.json").then((r) => r.json()),
    fetch("js/data/forms.json").then((r) => r.json()),
    fetch("js/data/spawns.json").then((r) => r.json()).catch(() => ({})),
    fetch("js/data/berries.json").then((r) => r.json()).catch(() => []),
    fetch("js/data/variants.json").then((r) => r.json()).catch(() => ({ regional: { alolan: [], galarian: [], hisuian: [], paldean: [] }, cosmetic: [] })),
  ]);
  SPECIES = sp;
  FORMS = { mega: fm.mega, primal: fm.primal, gmax: fm.gmax };
  VARIANTS = variants;
  SPAWNS = spawns;
  BERRIES = berries;
  BERRY_BY_ID = {};
  BERRIES.forEach((b) => (BERRY_BY_ID[b.id] = b));
  DEX_BY_NUM = {};
  SPECIES.forEach((s) => (DEX_BY_NUM[s.dex] = s));
  sanitizeSpawns();
  buildBiomeIndex();

  // Populate the target datalist once. Put the name in the label too, so browsers
  // that filter suggestions by the label (not the value) still match name typing.
  els.speciesList.innerHTML = SPECIES
    .map((s) => `<option value="${s.name}">#${String(s.dex).padStart(4, "0")} ${s.name}</option>`).join("");

  // Populate biome dropdown (sorted, with spawn counts).
  const biomeOpts = Object.keys(BIOME_INDEX).sort()
    .map((b) => `<option value="${b}">${b} (${BIOME_INDEX[b].length})</option>`).join("");
  els.spawnBiomeSelect.innerHTML = biomeOpts;
  els.snackBiome.innerHTML = biomeOpts;

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

  wire();
  fillConfigInputs();
  renderDex();
  renderForms();
  renderVariants();
  renderHunt();
  renderFarm();
  renderBoxes();
  renderSnack();
  const hash = location.hash.replace("#", "");
  if (hash) showTab(hash);
}
boot();
