// Find on this board: every word on it, not only drawn text. Notes, section
// names, to-do lists, link cards, board cards and where a photo came from.
import React, { useMemo, useState } from 'react';
import { cardWords } from './cards.jsx';

function wordsOf(e, all) {
  const d = e.customData || {};
  if (e.type === 'embeddable') {
    if (d.kind === 'todo') return { kind: 'To-do', text: [d.title, ...(d.items || []).map(i => i.t)].filter(Boolean).join(' · ') };
    if (d.kind === 'link') return { kind: 'Link', text: cardWords(e) };
    return null;
  }
  if (e.type === 'frame') return { kind: 'Section', text: e.name || '' };
  if (d.kind === 'board') return { kind: 'Board', text: d.title || '' };
  if (e.type === 'image' && d.source) return { kind: 'Photo', text: String(d.source) };
  if (e.type === 'text') {
    if (e.containerId) {
      const box = all.find(x => x.id === e.containerId);
      if (box && box.customData && box.customData.kind === 'board') return null;   // the card itself is listed
      return { kind: box && box.customData && box.customData.kind === 'note' ? 'Note' : 'Text', text: e.text || '', target: box || e };
    }
    return { kind: 'Text', text: e.text || '' };
  }
  return null;
}

// A short bit of the words around the match.
function snippet(text, term) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  const i = t.toLowerCase().indexOf(term);
  if (i < 0) return t.slice(0, 80);
  const a = Math.max(0, i - 30);
  return (a ? '…' : '') + t.slice(a, i + term.length + 50) + (i + term.length + 50 < t.length ? '…' : '');
}

export function FindPanel({ api, onClose }) {
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const hits = useMemo(() => {
    if (!api || !term) return [];
    const all = api.getSceneElements();
    const out = [];
    for (const e of all) {
      const w = wordsOf(e, all);
      if (!w || !String(w.text).toLowerCase().includes(term)) continue;
      out.push({ id: (w.target || e).id, el: w.target || e, kind: w.kind, text: snippet(w.text, term) });
      if (out.length >= 60) break;
    }
    return out;
  }, [api, term]);
  function show(el) {
    try {
      api.scrollToContent([el], { fitToViewport: true, viewportZoomFactor: 0.4, animate: true });
      api.updateScene({ appState: { selectedElementIds: { [el.id]: true }, selectedGroupIds: {} } });
    } catch (e) {}
  }
  return (
    <div className="side-panel find-panel" onPointerDown={e => e.stopPropagation()}>
      <div className="side-head"><span>Find on this board</span><button className="x" onClick={onClose} aria-label="Close">×</button></div>
      <input className="field find-field" autoFocus placeholder="Notes, to-dos, boards, sections…" value={q}
        onChange={e => setQ(e.target.value)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && hits[0]) show(hits[0].el); }} />
      {term && !hits.length && <div className="side-empty">Nothing on this board matches that.</div>}
      {hits.map(h => (
        <button key={h.id} className="side-item" onClick={() => show(h.el)}>
          <small className="find-kind">{h.kind}</small>
          <span className="find-text">{h.text}</span>
        </button>
      ))}
    </div>
  );
}
