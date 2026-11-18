// Images: shrink on the way in, and read a colour palette out of one.
import { blobToDataURL } from './store.js';

const MAX_SIDE = 1800;

// Phone photos are 3–12MB. A moodboard needs them sharp, not huge: long side
// 1800px, JPEG 0.86 unless the picture has transparency (then PNG stays PNG).
export async function prepareImage(blob) {
  const type = blob.type || 'image/png';
  if (type === 'image/svg+xml' || type === 'image/gif') {
    const dataURL = await blobToDataURL(blob);
    const { w, h } = await naturalSize(dataURL);
    return { dataURL, mimeType: type, width: w, height: h };
  }
  let bmp;
  try { bmp = await createImageBitmap(blob); }
  catch (e) {
    const dataURL = await blobToDataURL(blob);
    const { w, h } = await naturalSize(dataURL);
    return { dataURL, mimeType: type, width: w, height: h };
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d'); ctx.drawImage(bmp, 0, 0, w, h);
  const keepPng = type === 'image/png' && hasAlpha(ctx, w, h);
  const outType = keepPng ? 'image/png' : 'image/jpeg';
  const out = await new Promise(r => cv.toBlob(r, outType, 0.86));
  const use = (scale === 1 && blob.size <= (out ? out.size : Infinity)) ? blob : out;
  return { dataURL: await blobToDataURL(use), mimeType: use.type || outType, width: w, height: h };
}

function hasAlpha(ctx, w, h) {
  try {
    const d = ctx.getImageData(0, 0, Math.min(w, 200), Math.min(h, 200)).data;
    for (let i = 3; i < d.length; i += 16) if (d[i] < 250) return true;
  } catch (e) {}
  return false;
}

export function naturalSize(src) {
  return new Promise(res => { const im = new Image(); im.onload = () => res({ w: im.naturalWidth || 400, h: im.naturalHeight || 300 }); im.onerror = () => res({ w: 400, h: 300 }); im.src = src; });
}

// Fetch an image someone pasted or typed a link to. Many sites refuse a
// cross-site read; that comes back as null and the link is kept as a link.
export async function fetchImage(url) {
  try {
    const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!r.ok) return null;
    const blob = await r.blob();
    if (!/^image\//.test(blob.type)) return null;
    return blob;
  } catch (e) { return null; }
}

export const looksLikeImageUrl = (s) => /^https?:\/\/\S+\.(jpe?g|png|webp|gif|avif|svg)(\?\S*)?$/i.test(String(s || '').trim());

// ── palette ────────────────────────────────────────────────────────────────
// k-means on a 72px copy, seeded from a spread of the image so the result is
// stable for the same picture. Returns hex colours, most present first, with
// near-duplicates folded together.
export async function extractPalette(dataURL, k = 6) {
  const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataURL; });
  const S = 72, sc = Math.min(1, S / Math.max(im.naturalWidth, im.naturalHeight));
  const w = Math.max(1, Math.round(im.naturalWidth * sc)), h = Math.max(1, Math.round(im.naturalHeight * sc));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d'); ctx.drawImage(im, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const px = [];
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) px.push([d[i], d[i + 1], d[i + 2]]);
  if (!px.length) return [];
  let cents = [];
  for (let j = 0; j < k; j++) cents.push(px[Math.floor((j + 0.5) * px.length / k)].slice());
  let assign = new Array(px.length).fill(0);
  for (let it = 0; it < 12; it++) {
    const sums = cents.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < px.length; i++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < cents.length; j++) { const dd = dist2(px[i], cents[j]); if (dd < bd) { bd = dd; best = j; } }
      assign[i] = best; const s = sums[best]; s[0] += px[i][0]; s[1] += px[i][1]; s[2] += px[i][2]; s[3]++;
    }
    cents = sums.map((s, j) => s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3], s[3]] : [...cents[j].slice(0, 3), 0]);
  }
  cents.sort((a, b) => b[3] - a[3]);
  const out = [];
  for (const c of cents) {
    if (!c[3]) continue;
    if (out.some(o => dist2(o, c) < 24 * 24)) continue;
    out.push(c);
  }
  return out.map(c => '#' + c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join(''));
}
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

export function readableOn(hex) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#111111' : '#ffffff';
}
