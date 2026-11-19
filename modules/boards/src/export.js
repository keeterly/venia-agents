// Pictures of a board (Save as image, Print or save as PDF, board-card
// previews). Cards that draw themselves on the page (styled notes, to-do
// lists, link cards) are blank to the picture-maker, so each is swapped for a
// picture of itself first. Nothing on the board changes.
import { restoreElements } from '@excalidraw/excalidraw';
import { drawRich } from './rich.js';
import { readableOn } from './images.js';

const SANS = 'Helvetica, Arial, sans-serif';

function canvasFor(w, h, k) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d'); ctx.scale(k, k);
  return [c, ctx];
}

function clip(ctx, text, maxW) {
  let t = String(text || '');
  if (ctx.measureText(t).width <= maxW) return t;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

function drawTodo(ctx, w, h, d) {
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#cfcac0'; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  const items = (d.items || []).filter(i => i.t);
  ctx.fillStyle = '#111111'; ctx.font = '600 20px ' + SANS; ctx.textBaseline = 'alphabetic';
  ctx.fillText(clip(ctx, d.title || 'To do', w - 90), 16, 38);
  const done = items.filter(i => i.done).length;
  ctx.font = '400 14px ' + SANS; ctx.fillStyle = '#8a857c';
  if (items.length) { const c = done + '/' + items.length; ctx.fillText(c, w - 16 - ctx.measureText(c).width, 36); }
  items.forEach((it, n) => {
    const y = 66 + n * 40 + 20;
    if (y > h - 8) return;
    ctx.strokeStyle = '#8a857c'; ctx.lineWidth = 1.5; ctx.strokeRect(16.5, y - 15.5, 18, 18);
    if (it.done) { ctx.beginPath(); ctx.moveTo(20, y - 6); ctx.lineTo(24.5, y - 1.5); ctx.lineTo(31, y - 11); ctx.stroke(); }
    ctx.font = '400 18px ' + SANS; ctx.fillStyle = it.done ? '#8a857c' : '#111111';
    const t = clip(ctx, it.t, w - 64);
    ctx.fillText(t, 46, y);
    if (it.done) ctx.fillRect(46, y - 6, ctx.measureText(t).width, 1.2);
  });
}

function drawLink(ctx, w, h, d) {
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#cfcac0'; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  let site = d.site; if (!site) { try { site = new URL(d.url).hostname.replace(/^www\./, ''); } catch (e) { site = ''; } }
  const top = Math.max(16, h - 96);
  ctx.textBaseline = 'alphabetic';
  ctx.font = '500 12px ' + SANS; ctx.fillStyle = '#8a857c'; ctx.fillText(clip(ctx, String(site).toUpperCase(), w - 32), 16, top + 18);
  ctx.font = '600 17px ' + SANS; ctx.fillStyle = '#111111'; ctx.fillText(clip(ctx, d.title || d.url, w - 32), 16, top + 44);
}

// elements + files in, the same with self-drawn cards as pictures out.
export function flattenCards(elements, files, scale = 2) {
  const extra = {};
  const out = elements.map(e => {
    if (!e || e.isDeleted || e.type !== 'embeddable' || !e.customData) return e;
    const d = e.customData;
    const draw = d.kind === 'note' && d.rich ? (ctx) => { const bg = e.backgroundColor || '#F1ECE2'; drawRich(ctx, e.width, e.height, d.paras, bg, readableOn(bg)); }
      : d.kind === 'todo' ? (ctx) => drawTodo(ctx, e.width, e.height, d)
      : d.kind === 'link' ? (ctx) => drawLink(ctx, e.width, e.height, d) : null;
    if (!draw) return e;
    try {
      const [c, ctx] = canvasFor(e.width, e.height, scale);
      draw(ctx);
      const fileId = 'x-' + e.id + '-' + e.version;
      extra[fileId] = { id: fileId, dataURL: c.toDataURL('image/png'), mimeType: 'image/png', created: Date.now() };
      const [img] = restoreElements([{ ...e, type: 'image', fileId, status: 'saved', scale: [1, 1], crop: null, link: null, backgroundColor: 'transparent', strokeColor: 'transparent' }], null);
      return img;
    } catch (err) { return e; }
  });
  return { elements: out, files: Object.keys(extra).length ? { ...(files || {}), ...extra } : (files || {}) };
}
