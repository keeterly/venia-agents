// Notes whose words can be bold, italic, underlined or struck through
// (Build 651). The board's canvas can't style single words, so a styled note
// is one of Boards' own cards (an embeddable, like a to-do list) and keeps its
// words as paragraphs of runs: [[{t, b, i, u, s}, …], …]. This file is the
// plain part: reading and writing that shape, and drawing it on a canvas for
// pictures, PDFs and board-card previews.

export const RICH_FS = 22;            // the same size as a note's words
// Spaced like a note's own words (Excalidraw's Helvetica line height and the
// 5px it keeps inside a box), so a note looks the same before and after.
export const RICH_LH = 1.15;
export const RICH_PAD = 5;
const FONT = 'Helvetica, Arial, sans-serif';
const STYLES = ['b', 'i', 'u', 's'];

const clean = (r) => { const o = { t: String(r.t || '') }; STYLES.forEach(k => { if (r[k]) o[k] = true; }); return o; };
const same = (a, b) => STYLES.every(k => !!a[k] === !!b[k]);

// Join neighbours that look the same; drop empty runs (an empty paragraph keeps one).
export function tidy(paras) {
  const out = (Array.isArray(paras) ? paras : []).map(p => {
    const runs = [];
    (Array.isArray(p) ? p : []).map(clean).forEach(r => {
      if (!r.t) return;
      const last = runs[runs.length - 1];
      if (last && same(last, r)) last.t += r.t; else runs.push(r);
    });
    return runs;
  });
  return out.length ? out : [[]];
}

export const parasFromText = (text) => String(text || '').split('\n').map(line => (line ? [{ t: line }] : []));
export const plainOf = (paras) => (paras || []).map(p => (p || []).map(r => r.t).join('')).join('\n');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function htmlOf(paras) {
  return tidy(paras).map(p => '<div>' + (p.length ? p.map(r => {
    let h = esc(r.t);
    if (r.s) h = '<s>' + h + '</s>';
    if (r.u) h = '<u>' + h + '</u>';
    if (r.i) h = '<i>' + h + '</i>';
    if (r.b) h = '<b>' + h + '</b>';
    return h;
  }).join('') : '<br>') + '</div>').join('');
}

// Read what the editor holds back into paragraphs of runs. Only the four
// styles survive; anything else pasted in becomes plain words.
export function parasFromDom(root) {
  const paras = [[]];
  const cur = () => paras[paras.length - 1];
  const breakPara = () => { paras.push([]); };
  const walk = (node, st) => {
    if (node.nodeType === 3) { if (node.nodeValue) cur().push({ t: node.nodeValue.replace(/ /g, ' '), ...st }); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === 'BR') { breakPara(); return; }
    const s = { ...st };
    const css = node.style || {};
    if (tag === 'B' || tag === 'STRONG' || /^(bold|[6-9]00)$/.test(css.fontWeight || '')) s.b = true;
    if (tag === 'I' || tag === 'EM' || css.fontStyle === 'italic') s.i = true;
    const deco = String(css.textDecoration || css.textDecorationLine || '');
    if (tag === 'U' || /underline/.test(deco)) s.u = true;
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || /line-through/.test(deco)) s.s = true;
    const block = tag === 'DIV' || tag === 'P' || tag === 'LI';
    if (block && cur().length) breakPara();
    node.childNodes.forEach(c => walk(c, s));
    if (block && cur().length) breakPara();
  };
  root.childNodes.forEach(c => walk(c, {}));
  while (paras.length > 1 && !paras[paras.length - 1].length) paras.pop();
  return tidy(paras);
}

// Is one style on every word? (Used to decide whether a button turns it on or off.)
export const allHave = (paras, k) => { const runs = tidy(paras).flat().filter(r => r.t.trim()); return !!runs.length && runs.every(r => r[k]); };
// One style on (or off) across every word.
export const setAll = (paras, k, on) => tidy(tidy(paras).map(p => p.map(r => ({ ...r, [k]: on || undefined }))));
export const toggleAll = (paras, k) => setAll(paras, k, !allHave(paras, k));

// Where in the editor a plain-text position is (paragraph breaks count as one
// character), so a selection made in a plain note carries over.
export function pointAt(root, offset) {
  const blocks = [...root.childNodes];
  let left = offset;
  for (let b = 0; b < blocks.length; b++) {
    const walker = document.createTreeWalker(blocks[b], NodeFilter.SHOW_TEXT);
    let n, last = null;
    while ((n = walker.nextNode())) { last = n; if (left <= n.nodeValue.length) return [n, left]; left -= n.nodeValue.length; }
    if (b === blocks.length - 1 || left === 0) return last ? [last, last.nodeValue.length] : [blocks[b], 0];
    left -= 1;
  }
  return [root, root.childNodes.length];
}

// ── drawing, for pictures of the board ─────────────────────────────────────
const fontOf = (r, fs) => (r.i ? 'italic ' : '') + (r.b ? '700 ' : '400 ') + fs + 'px ' + FONT;

function lay(ctx, paras, width, fs) {
  const lines = [];
  for (const p of tidy(paras)) {
    let line = [], x = 0;
    const push = () => { lines.push(line); line = []; x = 0; };
    for (const r of p) {
      ctx.font = fontOf(r, fs);
      for (const piece of r.t.split(/(\s+)/)) {
        if (!piece) continue;
        const w = ctx.measureText(piece).width;
        if (x + w > width && line.length && piece.trim()) push();
        if (!line.length && !piece.trim()) continue;
        line.push({ r, t: piece, x, w }); x += w;
      }
    }
    push();
  }
  return lines;
}

// Draw a styled note onto a canvas: its colour, then its words.
export function drawRich(ctx, w, h, paras, bg, ink) {
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  const fs = RICH_FS, lh = fs * RICH_LH;
  const lines = lay(ctx, paras, w - RICH_PAD * 2, fs);
  ctx.textBaseline = 'alphabetic'; ctx.fillStyle = ink;
  lines.forEach((ln, i) => {
    const base = RICH_PAD + i * lh + fs;
    if (base > h) return;
    ln.forEach(seg => {
      ctx.font = fontOf(seg.r, fs);
      const x = RICH_PAD + seg.x;
      ctx.fillText(seg.t, x, base);
      if (seg.r.u) ctx.fillRect(x, base + 2.5, seg.w, Math.max(1, fs / 16));
      if (seg.r.s) ctx.fillRect(x, base - fs * 0.3, seg.w, Math.max(1, fs / 16));
    });
  });
}

// How tall a styled note needs to be for its words.
export function heightFor(paras, width) {
  try {
    const c = document.createElement('canvas').getContext('2d');
    const n = Math.max(1, lay(c, paras, width - RICH_PAD * 2, RICH_FS).length);
    return Math.ceil(RICH_PAD * 2 + n * RICH_FS * RICH_LH + 4);
  } catch (e) { return 0; }
}
