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
let state = { dex: {}, forms: {}, config: { baseShinyRate: 8192 } };

/* ---------- persistence ---------- */
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (d && typeof d === "object") state = Object.assign(state, d);
    if (!state.dex) state.dex = {};
    if (!state.forms) state.forms = {};
  } catch (_) { /* keep defaults */ }
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

/* ---------- tabs ---------- */
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
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
      state = Object.assign({ dex: {}, forms: {}, config: { baseShinyRate: 8192 } }, d);
      save();
      renderDex(); renderForms();
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

  els.dexSearch.addEventListener("input", renderDex);
  els.dexGen.addEventListener("change", renderDex);
  els.dexFilter.addEventListener("change", renderDex);

  els.exportBtn.addEventListener("click", exportData);
  els.importBtn.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", (e) => { if (e.target.files[0]) importData(e.target.files[0]); });
  els.resetAll.addEventListener("click", () => {
    if (confirm("Erase ALL progress? Export first if unsure.")) {
      state = { dex: {}, forms: {}, config: { baseShinyRate: 8192 } };
      save(); renderDex(); renderForms();
    }
  });
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
  const [sp, fm] = await Promise.all([
    fetch("js/data/species.json").then((r) => r.json()),
    fetch("js/data/forms.json").then((r) => r.json()),
  ]);
  SPECIES = sp;
  FORMS = { mega: fm.mega, primal: fm.primal, gmax: fm.gmax };
  wire();
  renderDex();
  renderForms();
  const hash = location.hash.replace("#", "");
  if (hash) showTab(hash);
}
boot();
