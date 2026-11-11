// What a factory link is allowed to carry (Build 603).
//
// The factory opens ?share=TOKEN with no login, so whatever this returns is in
// a stranger's browser, readable in its network tab whether or not the page
// draws it. Up to Build 602 the server sent the whole live style (costs, retail,
// margins, the internal notes thread, every earlier issue) and the ENTIRE
// material and vendor libraries, and the page hid what it didn't show. Hiding is
// not the same as not sending.
//
// Now the server builds the factory's copy here and sends only that:
//   - once a pack has been issued, the LATEST ISSUED copy (style, BOM, POM as
//     they were frozen), never the working copy;
//   - before the first issue, the working copy;
//   - in both cases with every cost, price and margin field removed, and the
//     house's own notes, comments, issue history and sales data left out;
//   - only the materials on that pack's BOM / pattern pieces, and only the
//     vendors that pack names (its factory and the suppliers of those
//     materials), each with an allow-listed set of fields.
//
// Plain JS on purpose: the edge function imports it, and the app's test suite
// runs it under Node.

// Style fields that never leave the house. A pattern catches the money fields
// (cogs, retail, wholesale, landed, duty, freight, dyeCost, marginTarget...),
// the list catches the rest.
const STYLE_MONEY = /cost|cogs|price|margin|wholesale|retail|landed|duty|freight|markup|tariff|msrp/i;
const STYLE_DROP = new Set([
  "notes", "comments", "checklist", "issued", "shareToken", "sampleLog",
  "bestSeller", "lsRank", "priority", "flag", "prevStatus", "archivedAt",
  "carryOver", "fromShopify", "shopifyAt", "shopifySkus", "shopifyStock",
  "shopifyUntracked", "shopifyVariants",
]);
// BOM rows: the factory needs what to buy and where it goes, not what it costs.
const BOM_DROP = /cost|price|_fromStyle/i;
// Materials and vendors: allow-listed, because a library row added next year
// with a new commercial field should stay home by default.
const MAT_KEEP = ["id", "name", "type", "article", "color", "colors", "content", "weight", "width", "unit", "photoUrl", "supplier", "lots"];
const LOT_DROP = /cost|price/i;
const VEN_KEEP = ["id", "name", "type", "city", "country", "location", "website", "contact", "email", "phone"];

function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
function pick(o, keys) { const r = {}; for (const k of keys) if (o && o[k] !== undefined) r[k] = clone(o[k]); return r; }
function norm(x) { return String(x == null ? "" : x).trim().toLowerCase(); }

export function cleanStyle(s) {
  const r = {};
  for (const [k, v] of Object.entries(s || {})) {
    if (STYLE_DROP.has(k) || STYLE_MONEY.test(k) || /^shopify/i.test(k)) continue;
    r[k] = clone(v);
  }
  return r;
}
export function cleanBom(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const r = {};
    for (const [k, v] of Object.entries(row || {})) if (!BOM_DROP.test(k)) r[k] = clone(v);
    return r;
  });
}
function cleanMaterial(m) {
  const r = pick(m, MAT_KEEP);
  if (Array.isArray(r.lots)) {
    r.lots = r.lots.map((l) => { const o = {}; for (const [k, v] of Object.entries(l || {})) if (!LOT_DROP.test(k)) o[k] = v; return o; });
  }
  return r;
}

// d: the workspace data ({styles, bom, pom, materials, vendors}); styleId: the
// shared style. Returns null when the style is gone.
export function factoryPack(d, styleId) {
  const live = (Array.isArray(d && d.styles) ? d.styles : []).find((x) => x && x.id === styleId);
  if (!live) return null;
  const hist = Array.isArray(live.issued) ? live.issued.filter((e) => e && e.style) : [];
  const last = hist.length ? hist[hist.length - 1] : null;

  const style = cleanStyle(last ? Object.assign({}, last.style, { id: live.id }) : live);
  const bom = cleanBom(last ? last.bom : (d.bom || {})[live.id]);
  const pom = clone(last ? (last.pom || []) : ((d.pom || {})[live.id] || []));

  // Materials named by this pack, and nothing else from the library.
  const matIds = new Set();
  bom.forEach((b) => { if (b.matId) matIds.add(b.matId); });
  (style.patternPieceList || []).forEach((p) => { if (p && p.matId) matIds.add(p.matId); });
  if (style.fabricMatId) matIds.add(style.fabricMatId);
  const materials = (Array.isArray(d.materials) ? d.materials : []).filter((m) => m && matIds.has(m.id)).map(cleanMaterial);

  // Vendors named by this pack: its factory, and the suppliers of its materials.
  const venIds = new Set(), venNames = new Set();
  if (live.vendorId || style.vendorId) venIds.add(style.vendorId || live.vendorId);
  if (style.vendor) venNames.add(norm(style.vendor));
  materials.forEach((m) => { if (m.supplier) venNames.add(norm(m.supplier)); });
  bom.forEach((b) => { if (b.supplier) venNames.add(norm(b.supplier)); });
  const vendors = (Array.isArray(d.vendors) ? d.vendors : [])
    .filter((v) => v && (venIds.has(v.id) || venNames.has(norm(v.name))))
    .map((v) => pick(v, VEN_KEEP));

  return {
    style,
    bom: { [live.id]: bom },
    pom: { [live.id]: pom },
    materials,
    vendors,
    pack: last ? "issued" : "working",
    issued: last ? { rev: last.rev, at: last.at, note: last.note || "", changes: Array.isArray(last.changes) ? last.changes : [] } : null,
  };
}
