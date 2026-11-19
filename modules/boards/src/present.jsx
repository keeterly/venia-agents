// Present (Build 656): every section (frame) on a board can be a slide.
//   Slides panel: the slides in order, move them up or down, hide one, set
//     its shape, add a new one at a set shape, play, save them as a PDF deck.
//   Presenter: full screen, one slide at a time; arrows, space, swipe or a tap
//     on either side to move; Esc to leave.
// The order, hidden flag and shape live on the frame itself, in
// customData.slide / slideSkip / size, so they travel with the board and undo
// like any other change. Columns are not slides. Nothing else on the board
// changes.
import React, { useEffect, useRef, useState } from 'react';
import { CaptureUpdateAction, convertToExcalidrawElements, exportToBlob, getCommonBounds, newElementWith } from '@excalidraw/excalidraw';
import { flattenCards } from './export.js';
import { isColumn } from './columns.js';

// Shapes a slide can start at, in board units (about screen pixels at 100%).
export const PRESETS = [
  { key: '16:9', label: '16:9', hint: 'Widescreen', w: 1280, h: 720 },
  { key: '4:3', label: '4:3', hint: 'Classic', w: 1024, h: 768 },
  { key: 'a4l', label: 'A4 landscape', hint: 'Print', w: 1123, h: 794 },
  { key: 'a4p', label: 'A4 portrait', hint: 'Print', w: 794, h: 1123 },
  { key: '1:1', label: 'Square', hint: 'Post', w: 1000, h: 1000 },
  { key: 'phone', label: 'Phone', hint: 'Story', w: 390, h: 844 },
];
const presetOf = (k) => PRESETS.find(p => p.key === k) || null;
export const sizeLabel = (f) => { const p = f && f.customData && presetOf(f.customData.size); return p ? p.label : 'Freeform'; };

const isSlideFrame = (e) => e && !e.isDeleted && (e.type === 'frame' || e.type === 'magicframe') && !isColumn(e);

// Every section that can be a slide, in slide order: a set order first, then
// the rest in reading order (rows top to bottom, left to right in a row).
export function allSlides(elements) {
  const fr = elements.filter(isSlideFrame);
  const reading = [...fr].sort((a, b) => {
    const rowA = Math.round(a.y / 200), rowB = Math.round(b.y / 200);
    return rowA !== rowB ? a.y - b.y : a.x - b.x;
  });
  const pos = new Map(reading.map((f, i) => [f.id, i]));
  const key = (f) => { const n = f.customData && f.customData.slide; return typeof n === 'number' ? n : 1e6 + pos.get(f.id); };
  return fr.sort((a, b) => key(a) - key(b));
}
export const shownSlides = (elements) => allSlides(elements).filter(f => !(f.customData && f.customData.slideSkip));

// Save a new order (an array of frame ids) and any per-frame changes.
function saveSlides(api, order, patch = {}) {
  const at = new Map(order.map((id, i) => [id, i]));
  const next = api.getSceneElementsIncludingDeleted().map(e => {
    if (!at.has(e.id) && !patch[e.id]) return e;
    const cd = { ...(e.customData || {}), ...(at.has(e.id) ? { slide: at.get(e.id) } : {}), ...(patch[e.id] && patch[e.id].customData || {}) };
    const extra = { ...(patch[e.id] || {}) }; delete extra.customData;
    return newElementWith(e, { ...extra, customData: cd });
  });
  api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
}

// Fit a section to a shape: same top-left corner, big enough for what's in it.
function shapeFor(api, frame, key) {
  const p = presetOf(key); if (!p) return null;
  const r = p.w / p.h;
  const kids = api.getSceneElements().filter(e => e.frameId === frame.id);
  let needW = 0, needH = 0;
  if (kids.length) { const [, , x2, y2] = getCommonBounds(kids); needW = x2 - frame.x + 16; needH = y2 - frame.y + 16; }
  let w = Math.max(frame.width, needW, needH * r);
  let h = w / r;
  if (h < needH) { h = needH; w = h * r; }
  return { width: Math.round(w), height: Math.round(h) };
}

// Where a new slide goes: to the right of the last slide, or of everything.
function spotForNew(api, w) {
  const live = api.getSceneElements();
  const slides = allSlides(live);
  if (slides.length) { const last = slides[slides.length - 1]; return { x: last.x + last.width + 80, y: last.y }; }
  if (!live.length) { const st = api.getAppState(); const z = st.zoom.value; return { x: -st.scrollX + 80 / z, y: -st.scrollY + 80 / z }; }
  const [, y1, x2] = getCommonBounds(live);
  return { x: x2 + 160, y: y1 };
}

export function addSlide(api, key) {
  const p = presetOf(key) || { w: 1000, h: 640 };
  const live = api.getSceneElements();
  const n = allSlides(live).length + 1;
  const at = spotForNew(api, p.w);
  const [f] = convertToExcalidrawElements([{ type: 'frame', x: at.x || 0.5, y: at.y || 0.5, width: p.w, height: p.h, name: 'Slide ' + n, children: [] }]);
  const frame = { ...f, customData: { size: presetOf(key) ? key : undefined, slide: n - 1 } };
  api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), frame], appState: { selectedElementIds: { [frame.id]: true }, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  try { api.scrollToContent(frame, { fitToViewport: true, viewportZoomFactor: 0.8, animate: true }); } catch (e) {}
  return frame;
}

// One slide as a picture. Only what overlaps the section is drawn.
async function slideBlob(api, frame, longSide) {
  const live = api.getSceneElements();
  const fx2 = frame.x + frame.width, fy2 = frame.y + frame.height;
  const near = new Set();
  for (const e of live) {
    if (e.id === frame.id || e.frameId === frame.id) { near.add(e.id); continue; }
    if (e.containerId) continue;
    let b; try { b = getCommonBounds([e]); } catch (err) { continue; }
    if (b[2] >= frame.x && b[0] <= fx2 && b[3] >= frame.y && b[1] <= fy2) near.add(e.id);
  }
  live.forEach(e => { if (e.containerId && near.has(e.containerId)) near.add(e.id); });
  const flat = flattenCards(live.filter(e => near.has(e.id)), api.getFiles(), 2);
  const fr = flat.elements.find(e => e.id === frame.id) || frame;
  return exportToBlob({
    elements: flat.elements, files: flat.files, mimeType: 'image/png', exportingFrame: fr, exportPadding: 0,
    getDimensions: (w, h) => { const k = Math.min(4, longSide / Math.max(w, h)); return { width: w * k, height: h * k, scale: k }; },
    appState: { exportBackground: true, viewBackgroundColor: api.getAppState().viewBackgroundColor || '#F7F6F2' },
  });
}

// All shown slides as one PDF, one slide to a page, through the print
// dialog's "Save as PDF" (no new service or library, like Print the board).
export async function printDeck(api, title) {
  const slides = shownSlides(api.getSceneElements());
  if (!slides.length) return false;
  const pages = [];
  for (const f of slides) {
    const blob = await slideBlob(api, f, 2200);
    pages.push({ url: URL.createObjectURL(blob), land: f.width >= f.height });
  }
  const safe = String(title || 'Board').replace(/[<>&]/g, '');
  const fr = document.createElement('iframe');
  fr.setAttribute('aria-hidden', 'true');
  fr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(fr);
  const d = fr.contentDocument;
  const first = pages[0].land ? 'landscape' : 'portrait';
  d.open();
  d.write('<!doctype html><html><head><title>' + safe + '</title><style>'
    + '@page{size:A4 ' + first + ';margin:0}@page land{size:A4 landscape;margin:0}@page port{size:A4 portrait;margin:0}'
    + 'html,body{margin:0;background:#fff}.pg{height:100vh;display:flex;align-items:center;justify-content:center;break-after:page;page-break-after:always;overflow:hidden}'
    + '.pg:last-child{break-after:auto;page-break-after:auto}.pg.l{page:land}.pg.p{page:port}img{max-width:100%;max-height:100vh;object-fit:contain;display:block}'
    + '</style></head><body>' + pages.map(p => '<div class="pg ' + (p.land ? 'l' : 'p') + '"><img></div>').join('') + '</body></html>');
  d.close();
  const imgs = [...d.querySelectorAll('img')];
  let left = imgs.length;
  const done = () => {
    if (--left > 0) return;
    setTimeout(() => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch (e) {} setTimeout(() => { fr.remove(); pages.forEach(p => URL.revokeObjectURL(p.url)); }, 60000); }, 80);
  };
  imgs.forEach((im, i) => { im.onload = done; im.onerror = done; im.src = pages[i].url; });
  return true;
}

const Ico = ({ d }) => <svg viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg>;

// Re-read the slides whenever the board changes.
function useSlides(api) {
  const [list, setList] = useState(() => (api ? allSlides(api.getSceneElements()) : []));
  useEffect(() => {
    if (!api) return;
    let sig = '';
    const read = (els) => {
      const s = allSlides((els || api.getSceneElements()).filter(e => !e.isDeleted));
      const n = s.map(f => f.id + ':' + f.version).join(',');
      if (n !== sig) { sig = n; setList(s); }
    };
    read();
    let un = null; try { un = api.onChange((els) => read(els)); } catch (e) {}
    return () => { if (typeof un === 'function') un(); };
  }, [api]);
  return list;
}

export function SlidesPanel({ api, title, onClose, onPlay, setStatus, canEdit = true }) {
  const slides = useSlides(api);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const ids = slides.map(f => f.id);
  const shown = slides.filter(f => !(f.customData && f.customData.slideSkip));

  const move = (i, by) => {
    const j = i + by; if (j < 0 || j >= ids.length) return;
    const next = [...ids]; [next[i], next[j]] = [next[j], next[i]];
    saveSlides(api, next);
  };
  const toggle = (f) => saveSlides(api, ids, { [f.id]: { customData: { slideSkip: !(f.customData && f.customData.slideSkip) || undefined } } });
  const reshape = (f, key) => {
    if (key === 'free') { saveSlides(api, ids, { [f.id]: { customData: { size: undefined } } }); return; }
    const s = shapeFor(api, f, key); if (!s) return;
    saveSlides(api, ids, { [f.id]: { ...s, customData: { size: key } } });
  };
  const show = (f) => { try { api.updateScene({ appState: { selectedElementIds: { [f.id]: true }, selectedGroupIds: {} } }); api.scrollToContent(f, { fitToViewport: true, viewportZoomFactor: 0.85, animate: true }); } catch (e) {} };
  const pdf = async () => {
    setBusy(true);
    try { const ok = await printDeck(api, title); if (!ok) setStatus('Add a slide first'); }
    catch (e) { setStatus('Couldn’t make the PDF'); }
    finally { setBusy(false); }
  };

  return (
    <aside className="side-panel slides-panel" onPointerDown={e => e.stopPropagation()}>
      <div className="side-head">Slides<button className="link" onClick={onClose} aria-label="Close">Close</button></div>
      <div className="slides-top">
        <button className="solid" disabled={!shown.length} onClick={() => onPlay(0)}><Ico d="M7 5l12 7-12 7z" />Present</button>
        <button className="ghost" disabled={!shown.length || busy} onClick={pdf}>{busy ? 'Making the PDF…' : 'Save as PDF'}</button>
      </div>
      {!slides.length && <div className="side-empty">{canEdit ? 'Every section on the board is a slide. Add one below at the shape you need, then drag photos and notes into it.' : 'This board has no sections to show yet.'}</div>}
      <ol className="slides-list">
        {slides.map((f, i) => {
          const skip = !!(f.customData && f.customData.slideSkip);
          const size = (f.customData && f.customData.size) || 'free';
          return (
            <li key={f.id} className={skip ? 'skip' : ''}>
              <button className="sl-name" onClick={() => show(f)} title="Show it on the board">
                <span className="sl-n">{skip ? '–' : shown.indexOf(f) + 1}</span>
                <span className="sl-t">{f.name || 'Section'}</span>
              </button>
              {canEdit && <select className="sl-size" value={size} onChange={e => reshape(f, e.target.value)} aria-label={'Shape of ' + (f.name || 'this slide')}>
                <option value="free">Freeform</option>
                {PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>}
              <span className="sl-btns">
                {canEdit && <><button onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><Ico d="M12 19V5 M6 11l6-6 6 6" /></button>
                <button onClick={() => move(i, 1)} disabled={i === slides.length - 1} aria-label="Move down"><Ico d="M12 5v14 M6 13l6 6 6-6" /></button>
                <button onClick={() => toggle(f)} aria-label={skip ? 'Show in the presentation' : 'Leave out of the presentation'} title={skip ? 'Left out: tap to show it' : 'Leave it out'}>
                  <Ico d={skip ? 'M3 3l18 18 M10.6 6.1A10 10 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3 3.6 M6.6 6.6C3.9 8.4 2.5 12 2.5 12s3.5 6 9.5 6a9.6 9.6 0 0 0 5.4-1.6' : 'M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z M12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5z'} />
                </button></>}
                <button onClick={() => onPlay(Math.max(0, shown.indexOf(f)))} disabled={skip} aria-label="Present from here"><Ico d="M8 6l10 6-10 6z" /></button>
              </span>
            </li>
          );
        })}
      </ol>
      {canEdit && <div className="slides-add">
        {!adding ? <button className="ghost wide" onClick={() => setAdding(true)}><Ico d="M12 5v14 M5 12h14" />Add a slide</button> : (
          <>
            <div className="pop-label">Pick a shape</div>
            <div className="shape-grid">
              {PRESETS.map(p => (
                <button key={p.key} onClick={() => { addSlide(api, p.key); setAdding(false); }}>
                  <span className="shape-ic" style={{ aspectRatio: p.w + ' / ' + p.h }} />
                  <b>{p.label}</b><small>{p.hint}</small>
                </button>
              ))}
              <button onClick={() => { addSlide(api, null); setAdding(false); }}>
                <span className="shape-ic free" /><b>Freeform</b><small>Any size</small>
              </button>
            </div>
          </>
        )}
      </div>}
    </aside>
  );
}

export function Presenter({ api, start, onClose }) {
  const [slides] = useState(() => shownSlides(api.getSceneElements()));
  const [at, setAt] = useState(() => Math.min(start || 0, Math.max(0, slides.length - 1)));
  const [urls, setUrls] = useState({});
  const [chrome, setChrome] = useState(true);
  const root = useRef(null);
  const made = useRef(new Map());
  const timer = useRef(0);
  const side = Math.min(3200, Math.round(Math.max(window.innerWidth, window.innerHeight) * Math.min(2, window.devicePixelRatio || 1)));

  // Draw the slide on screen and the ones either side of it.
  useEffect(() => {
    let off = false;
    [at, at + 1, at - 1].forEach(i => {
      const f = slides[i]; if (!f || made.current.has(f.id)) return;
      made.current.set(f.id, null);
      slideBlob(api, f, side).then(b => { const u = URL.createObjectURL(b); made.current.set(f.id, u); if (!off) setUrls(o => ({ ...o, [f.id]: u })); }).catch(() => {});
    });
    return () => { off = true; };
  }, [at]);
  useEffect(() => () => { made.current.forEach(u => u && URL.revokeObjectURL(u)); }, []);

  const go = (by) => setAt(a => Math.max(0, Math.min(slides.length - 1, a + by)));
  const wake = () => { setChrome(true); clearTimeout(timer.current); timer.current = setTimeout(() => setChrome(false), 2500); };
  const close = () => { try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {} onClose(); };

  useEffect(() => {
    try { const el = root.current; if (el && el.requestFullscreen) el.requestFullscreen().catch(() => {}); } catch (e) {}
    wake();
    const key = (e) => {
      const k = e.key;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(k)) go(1);
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k)) go(-1);
      else if (k === 'Home') setAt(0);
      else if (k === 'End') setAt(slides.length - 1);
      else if (k === 'Escape') close();
      else return;
      e.preventDefault(); e.stopPropagation();
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); clearTimeout(timer.current); };
  }, []);

  // Swipe left or right; a tap on the right side goes on, on the left goes back.
  const down = useRef(null);
  const onDown = (e) => { if (e.target.closest('.pr-ctl')) return; down.current = { x: e.clientX, y: e.clientY, t: Date.now() }; };
  const onUp = (e) => {
    const d = down.current; down.current = null; if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) { go(dx < 0 ? 1 : -1); return; }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) { const w = root.current ? root.current.clientWidth : window.innerWidth; if (e.clientX > w * 0.35) go(1); else go(-1); wake(); }
  };

  const f = slides[at];
  const u = f && urls[f.id];
  return (
    <div className={'presenter' + (chrome ? '' : ' quiet')} ref={root} onPointerDown={onDown} onPointerUp={onUp} onPointerMove={wake} role="dialog" aria-label="Presenting">
      {!slides.length && <div className="pr-empty">There are no slides to show.</div>}
      {f && (u ? <img className="pr-img" src={u} alt={f.name || 'Slide ' + (at + 1)} draggable={false} /> : <div className="pr-wait">Getting the slide ready…</div>)}
      <div className="pr-ctl">
        <button onClick={() => go(-1)} disabled={at === 0} aria-label="Previous slide"><Ico d="M15 5l-7 7 7 7" /></button>
        <span className="pr-count">{slides.length ? (at + 1) + ' / ' + slides.length : ''}</span>
        <button onClick={() => go(1)} disabled={at >= slides.length - 1} aria-label="Next slide"><Ico d="M9 5l7 7-7 7" /></button>
        <span className="pr-sep" />
        <button onClick={close} aria-label="Stop presenting"><Ico d="M6 6l12 12 M18 6L6 18" /></button>
      </div>
    </div>
  );
}
