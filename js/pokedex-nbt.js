/* ---------- Cobblemon Pokédex (.nbt) parser ----------
 *
 * Reads the per-player Pokédex NBT the server writes and turns it into the same
 * flat entry list the ShinyDex Link mod export produces — so app.js can feed it
 * straight through the existing upgrade-only merge (`mergeModEntries`).
 *
 * On disk (Cobblemon 1.7.3, DexDataNbtBackend -> NbtBackedPlayerData):
 *
 *   <world>/pokedex/<first 2 chars of uuid>/<player-uuid>.nbt
 *
 * Uncompressed in practice, but gzip/zlib are sniffed and handled anyway. The
 * `knowledge` values are Cobblemon's PokedexEntryProgress enum, which is exactly
 * NONE / ENCOUNTERED / CAUGHT.
 *
 * Zero dependencies, no build step. Classic script: exposes `window.ShinyDexNbt`
 * (and `module.exports` so it can be unit-tested under Node).
 *
 * File shape (verified against a real 301-species save):
 *
 *   root (TAG_Compound, unnamed)
 *     uuid            "ee79dc49-…"
 *     speciesRecords
 *       "cobblemon:meowth"
 *         aspects       ["female","bucket-common","male","shiny","galarian"]
 *         formRecords
 *           "normal"    { knowledge: "CAUGHT", seenShinyStates: ["normal","shiny"],
 *                         genders: ["MALE","FEMALE"] }
 *           "galar"     { knowledge: "CAUGHT", seenShinyStates: ["normal"], … }
 *
 * Two traps this parser is built around:
 *
 * 1. Species-level `aspects` is a UNION over every form. Meowth above lists
 *    "shiny" AND "galarian", but the shiny is the *normal* form — the Galarian
 *    one isn't shiny. (Gimmighoul is the mirror case: the shiny is the `roaming`
 *    form, not `normal`.) So shininess and form are read ONLY from `formRecords`,
 *    never from the species `aspects` union.
 *
 * 2. `knowledge` is per-form (CAUGHT / ENCOUNTERED / NONE); `seenShinyStates` only
 *    says a shiny of that form was *seen*. Cobblemon does not record "caught the
 *    shiny" as distinct from "caught a normal + saw a shiny". We therefore only
 *    claim ✨shiny when the form is CAUGHT *and* a shiny was seen — see
 *    `shinyRequiresCaught`. The site's merge is upgrade-only, so over-claiming
 *    here would be unfixable by a later import.
 */
(function (global) {
  "use strict";

  /* ---------- NBT reader ---------- */

  const TAG_END = 0, TAG_BYTE = 1, TAG_SHORT = 2, TAG_INT = 3, TAG_LONG = 4,
        TAG_FLOAT = 5, TAG_DOUBLE = 6, TAG_BYTE_ARRAY = 7, TAG_STRING = 8,
        TAG_LIST = 9, TAG_COMPOUND = 10, TAG_INT_ARRAY = 11, TAG_LONG_ARRAY = 12;

  // Deeply-nested compounds would otherwise blow the JS stack on a hostile file.
  const MAX_DEPTH = 512;

  const utf8 = new TextDecoder("utf-8");

  class Reader {
    constructor(bytes) {
      this.b = bytes;
      this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.i = 0;
    }
    need(n) {
      if (this.i + n > this.b.length) {
        throw new Error(`truncated NBT: wanted ${n} more byte(s) at offset ${this.i} of ${this.b.length}`);
      }
    }
    u8() { this.need(1); return this.b[this.i++]; }
    i8() { this.need(1); const v = this.dv.getInt8(this.i); this.i += 1; return v; }
    i16() { this.need(2); const v = this.dv.getInt16(this.i); this.i += 2; return v; }
    u16() { this.need(2); const v = this.dv.getUint16(this.i); this.i += 2; return v; }
    i32() { this.need(4); const v = this.dv.getInt32(this.i); this.i += 4; return v; }
    i64() { this.need(8); const v = this.dv.getBigInt64(this.i); this.i += 8; return v; }
    f32() { this.need(4); const v = this.dv.getFloat32(this.i); this.i += 4; return v; }
    f64() { this.need(8); const v = this.dv.getFloat64(this.i); this.i += 8; return v; }
    str() {
      const n = this.u16();
      this.need(n);
      // Java writes modified UTF-8. For the BMP text NBT actually carries (species
      // ids, form names, "pa’u") that is byte-identical to UTF-8.
      const s = utf8.decode(this.b.subarray(this.i, this.i + n));
      this.i += n;
      return s;
    }
    // Guard a declared array/list length against the bytes that actually remain,
    // so a corrupt length can't make us allocate gigabytes.
    count(stride) {
      const n = this.i32();
      if (n < 0) throw new Error(`negative NBT length ${n} at offset ${this.i - 4}`);
      if (stride > 0 && this.i + n * stride > this.b.length) {
        throw new Error(`NBT length ${n} overruns the file at offset ${this.i - 4}`);
      }
      return n;
    }
  }

  // TAG_Long is read as BigInt: a Minecraft long can exceed Number.MAX_SAFE_INTEGER
  // (world seeds, UUID halves), and silently rounding it would be worse than a type
  // the caller has to opt into. Nothing in the Pokédex uses longs.
  function payload(r, tag, depth) {
    if (depth > MAX_DEPTH) throw new Error(`NBT nested deeper than ${MAX_DEPTH}`);
    switch (tag) {
      case TAG_END: return null;
      case TAG_BYTE: return r.i8();
      case TAG_SHORT: return r.i16();
      case TAG_INT: return r.i32();
      case TAG_LONG: return r.i64();
      case TAG_FLOAT: return r.f32();
      case TAG_DOUBLE: return r.f64();
      case TAG_BYTE_ARRAY: {
        const n = r.count(1);
        const v = r.b.slice(r.i, r.i + n);
        r.i += n;
        return v;
      }
      case TAG_STRING: return r.str();
      case TAG_LIST: {
        const et = r.u8();
        const n = r.count(0);
        // An empty list is written with element type TAG_End.
        if (et === TAG_END) {
          if (n > 0) throw new Error(`TAG_List of TAG_End with length ${n}`);
          return [];
        }
        const out = new Array(n);
        for (let k = 0; k < n; k++) out[k] = payload(r, et, depth + 1);
        return out;
      }
      case TAG_COMPOUND: {
        const out = {};
        for (;;) {
          const t = r.u8();
          if (t === TAG_END) break;
          out[r.str()] = payload(r, t, depth + 1);
        }
        return out;
      }
      case TAG_INT_ARRAY: {
        const n = r.count(4);
        const v = new Int32Array(n);
        for (let k = 0; k < n; k++) v[k] = r.i32();
        return v;
      }
      case TAG_LONG_ARRAY: {
        const n = r.count(8);
        const v = new BigInt64Array(n);
        for (let k = 0; k < n; k++) v[k] = r.i64();
        return v;
      }
      default: throw new Error(`unknown NBT tag ${tag} at offset ${r.i - 1}`);
    }
  }

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new Error("expected an ArrayBuffer / Uint8Array");
  }

  /* Parse an uncompressed NBT buffer. Returns { name, value } for the root tag. */
  function readNbt(input) {
    const r = new Reader(toBytes(input));
    const tag = r.u8();
    if (tag !== TAG_COMPOUND) throw new Error(`not NBT: root tag is ${tag}, expected 10 (TAG_Compound)`);
    const name = r.str();
    const value = payload(r, tag, 0);
    return { name, value };
  }

  /* ---------- decompression ---------- */

  // Level/player NBT is usually gzipped; Cobblemon writes the Pokédex plain. Sniff
  // rather than trust the extension.
  function compression(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
    // zlib: CMF=0x78, and (CMF<<8|FLG) % 31 === 0.
    if (bytes.length >= 2 && bytes[0] === 0x78 && ((bytes[0] << 8) | bytes[1]) % 31 === 0) return "deflate";
    return null;
  }

  async function inflate(input) {
    const bytes = toBytes(input);
    const fmt = compression(bytes);
    if (!fmt) return bytes;
    if (typeof global.DecompressionStream !== "function") {
      throw new Error(`this ${fmt}-compressed .nbt needs DecompressionStream (unsupported browser)`);
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new global.DecompressionStream(fmt));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* ---------- Pokédex layer ---------- */

  const KNOWLEDGE = { CAUGHT: "caught", ENCOUNTERED: "seen", NONE: "none" };

  // Cobblemon's base form. Everything else is a variant the site tracks separately,
  // so a base catch must never be diverted into the Variants tab (and vice-versa).
  const BASE_FORMS = new Set(["normal"]);

  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  /* Pull `{ uuid, species: [...] }` out of a parsed root compound. Accepts the
   * `{name, value}` envelope from readNbt(), a bare root compound, or a root that
   * nests the dex one level down. */
  function parsePokedex(root) {
    let c = root && root.value !== undefined && root.name !== undefined ? root.value : root;
    if (!c || typeof c !== "object") throw new Error("not a Pokédex NBT (empty root)");
    if (!c.speciesRecords) {
      const nested = Object.values(c).find((v) => v && typeof v === "object" && v.speciesRecords);
      if (!nested) throw new Error("not a Cobblemon Pokédex NBT (no speciesRecords)");
      c = nested;
    }

    const species = [];
    for (const [id, rec] of Object.entries(c.speciesRecords)) {
      if (!rec || typeof rec !== "object") continue;
      const colon = id.indexOf(":");
      const forms = [];
      for (const [form, fr] of Object.entries(rec.formRecords || {})) {
        if (!fr || typeof fr !== "object") continue;
        const shinyStates = Array.isArray(fr.seenShinyStates) ? fr.seenShinyStates : [];
        forms.push({
          form,
          knowledge: String(fr.knowledge || "NONE"),
          genders: Array.isArray(fr.genders) ? fr.genders : [],
          shinyStates,
          seenShiny: shinyStates.includes("shiny"),
        });
      }
      species.push({
        id,
        namespace: colon > 0 ? id.slice(0, colon) : "",
        name: colon > 0 ? id.slice(colon + 1) : id,
        // Kept for display/debugging only — it is a union across forms, so it must
        // not drive shiny or variant decisions. See the header note.
        aspects: Array.isArray(rec.aspects) ? rec.aspects : [],
        forms,
      });
    }
    return { uuid: typeof c.uuid === "string" ? c.uuid : null, species };
  }

  /* national-dex resolver.
   *
   * Cobblemon names species bare ("indeedee", "minior"); species.json carries
   * PokeAPI's default-form suffix ("indeedee-male", "minior-red-meteor"). So: try
   * an exact normalized match, then fall back to a base name ("indeedee") when it
   * is unambiguous. The only ambiguous bases — iron/mr/nidoran/tapu — already hit
   * the exact path once separators are stripped ("mr_mime" → "mrmime"). */
  function dexResolver(speciesList) {
    const exact = new Map();
    const byBase = new Map();
    for (const s of speciesList || []) {
      exact.set(norm(s.name), s.dex);
      const base = norm(String(s.name).split("-")[0]);
      if (!byBase.has(base)) byBase.set(base, []);
      byBase.get(base).push(s.dex);
    }
    return (name) => {
      const k = norm(name);
      if (exact.has(k)) return exact.get(k);
      const cands = byBase.get(k);
      return cands && cands.length === 1 ? cands[0] : undefined;
    };
  }

  /* Flatten a parsed Pokédex into mod-export-shaped entries:
   *
   *   { species, dex, form, aspects, seen, caught, shiny }
   *
   * One entry per *form record*, because that is the only level at which shiny and
   * form are unambiguous. Base ("normal") forms get form:"" so they land on the
   * national-dex slot; every other form keeps its name as the variant token
   * ("galar", "hisui-bias", "antique", "roaming", …), which app.js matches against
   * variants.json. Forms with no matching variant (mewtwo "armored", zacian
   * "crowned") fall through to the base dex slot, which is the right answer.
   *
   * Options:
   *   species              — the site's species.json array (required for `dex`)
   *   shinyRequiresCaught  — default true; see the header note on trap #2
   */
  function pokedexEntries(pokedex, opts) {
    const o = opts || {};
    const resolve = dexResolver(o.species);
    const shinyRequiresCaught = o.shinyRequiresCaught !== false;
    const entries = [];

    for (const sp of pokedex.species || []) {
      const dex = resolve(sp.name);
      for (const f of sp.forms) {
        const base = KNOWLEDGE[f.knowledge] || "none";
        if (base === "none") continue;
        const shiny = f.seenShiny && (base === "caught" || !shinyRequiresCaught);
        entries.push({
          species: sp.name,
          dex,
          form: BASE_FORMS.has(f.form) ? "" : f.form,
          // Deliberately empty: the species `aspects` union would misattribute
          // "shiny" (and regional tags) to the wrong form.
          aspects: [],
          seen: true,
          caught: base === "caught" || shiny,
          shiny,
        });
      }
    }
    return entries;
  }

  function summarize(entries) {
    const s = { entries: entries.length, seen: 0, caught: 0, shiny: 0, forms: 0, unresolved: 0 };
    for (const e of entries) {
      if (!Number.isFinite(e.dex)) s.unresolved++;
      if (e.form) s.forms++;
      if (e.shiny) s.shiny++;
      else if (e.caught) s.caught++;
      else s.seen++;
    }
    return s;
  }

  /* One-shot: File/Blob/ArrayBuffer -> { uuid, species, entries, summary }. */
  async function parsePokedexFile(input, opts) {
    let buf = input;
    if (typeof Blob !== "undefined" && input instanceof Blob) buf = await input.arrayBuffer();
    const bytes = await inflate(buf);
    const pokedex = parsePokedex(readNbt(bytes));
    const entries = pokedexEntries(pokedex, opts);
    return { uuid: pokedex.uuid, species: pokedex.species, entries, summary: summarize(entries) };
  }

  const API = { readNbt, inflate, parsePokedex, pokedexEntries, parsePokedexFile, summarize, dexResolver };
  global.ShinyDexNbt = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
