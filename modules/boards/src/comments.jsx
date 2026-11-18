// Comments on a board, with @ mentions.
//
// Click Comment, then click anywhere on the board: the comment pins to that
// spot, or to the item under it (and then follows the item when it moves).
// Type @ to mention someone who has Brainstorm; they see it in their Today
// in VENIA OS, and opening it brings them here. Threads can be answered,
// resolved and reopened. Nothing is ever erased: removing your own comment
// hides it.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { sceneCoordsToViewportCoords, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw';
import { store, nameOf } from './store.js';

export function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Group flat rows into threads (root + replies, oldest first).
export function threadsOf(rows) {
  const roots = rows.filter(r => !r.thread_id);
  const by = Object.fromEntries(roots.map(r => [r.id, { root: r, replies: [] }]));
  rows.filter(r => r.thread_id && by[r.thread_id]).forEach(r => by[r.thread_id].replies.push(r));
  return roots.map(r => by[r.id]);
}

// Where a thread sits on the board right now, in board coordinates.
export function spotOf(api, c) {
  if (!c.element_id) return { x: c.x, y: c.y };
  const el = api.getSceneElements().find(e => e.id === c.element_id);
  return el ? { x: el.x + c.x, y: el.y + c.y } : null;
}

// The item under a point: the topmost thing that isn't a frame, else a frame.
function itemAt(api, p) {
  const els = api.getSceneElements().slice().reverse();
  const inside = (e) => e.width > 0 && e.height > 0 && p.x >= e.x && p.x <= e.x + e.width && p.y >= e.y && p.y <= e.y + e.height;
  const hit = els.find(e => e.type !== 'frame' && e.type !== 'selection' && !['line', 'arrow', 'freedraw'].includes(e.type) && inside(e))
    || els.find(e => e.type === 'frame' && inside(e));
  if (!hit) return null;
  if (hit.containerId) return els.find(e => e.id === hit.containerId) || hit;
  return hit;
}

export function focusSpot(api, spot) {
  const st = api.getAppState(); const z = st.zoom.value;
  api.updateScene({ appState: { scrollX: st.width / 2 / z - spot.x, scrollY: st.height / 2 / z - spot.y } });
}

// Turn "@Christine" tokens back into the emails of the people they name.
function mentionsIn(body, people) {
  const found = new Set();
  for (const p of people) {
    const re = new RegExp('@' + p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(body)) found.add(p.email);
  }
  return [...found];
}

function Body({ text, people }) {
  // Show "@Name" in bold where it names someone.
  const names = people.map(p => p.name).filter(Boolean);
  if (!names.length) return <span>{text}</span>;
  const re = new RegExp('(@(?:' + names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b)', 'gi');
  return <span>{String(text).split(re).map((part, i) => i % 2 ? <b key={i} className="mention">{part}</b> : part)}</span>;
}

export function MentionBox({ people, placeholder, onSend, autoFocus, busy }) {
  const [v, setV] = useState('');
  const [q, setQ] = useState(null);     // the text after @ being typed
  const ref = useRef(null);
  const sugg = useMemo(() => q === null ? [] : people.filter(p => (p.name + ' ' + p.email).toLowerCase().includes(q.toLowerCase())).slice(0, 5), [q, people]);
  const [hi, setHi] = useState(0);
  function onChange(e) {
    const t = e.target.value; setV(t);
    const upto = t.slice(0, e.target.selectionStart);
    const m = upto.match(/(?:^|\s)@([\w.-]*)$/);
    setQ(m && people.length ? m[1] : null); setHi(0);
  }
  function pick(p) {
    const el = ref.current; const pos = el.selectionStart;
    const before = v.slice(0, pos).replace(/@([\w.-]*)$/, '@' + p.name + ' ');
    const next = before + v.slice(pos);
    setV(next); setQ(null);
    setTimeout(() => { el.focus(); el.selectionStart = el.selectionEnd = before.length; }, 0);
  }
  function send() {
    const body = v.trim(); if (!body || busy) return;
    onSend(body, mentionsIn(body, people)); setV(''); setQ(null);
  }
  return (
    <div className="mention-box">
      <textarea ref={ref} autoFocus={autoFocus} rows={2} value={v} placeholder={placeholder || (people.length ? 'Write a comment. Type @ to mention someone.' : 'Write a comment')}
        onChange={onChange}
        onKeyDown={e => {
          e.stopPropagation();
          if (sugg.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setHi(h => (h + (e.key === 'ArrowDown' ? 1 : -1) + sugg.length) % sugg.length); return; }
          if (sugg.length && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); pick(sugg[hi]); return; }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          if (e.key === 'Escape') setQ(null);
        }} />
      {sugg.length > 0 && (
        <div className="mention-list">
          {sugg.map((p, i) => <button key={p.email} className={i === hi ? 'on' : ''} onMouseDown={e => { e.preventDefault(); pick(p); }}><b>{p.name}</b><small>{p.email}</small></button>)}
        </div>
      )}
      <div className="mention-foot"><button className="solid sm" disabled={!v.trim() || busy} onClick={send}>Send</button></div>
    </div>
  );
}

function Thread({ t, people, onReply, onResolve, onHide, onClose, canResolve }) {
  const all = [t.root, ...t.replies];
  return (
    <div className="thread" onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
      <div className="thread-head">
        <span>{t.root.resolved_at ? 'Resolved' : 'Comment'}</span>
        <div>
          {canResolve && <button className="link" onClick={() => onResolve(t.root, !t.root.resolved_at)}>{t.root.resolved_at ? 'Reopen' : 'Resolve'}</button>}
          <button className="x" onClick={onClose} aria-label="Close">×</button>
        </div>
      </div>
      <div className="thread-msgs">
        {all.map(c => (
          <div key={c.id} className="msg">
            <div className="msg-meta"><b>{nameOf(c.author)}</b> · {ago(c.created_at)}
              {c.author === (store.email || 'you') && <button className="link quiet" onClick={() => onHide(c)}>Remove</button>}
            </div>
            <div className="msg-body"><Body text={c.body} people={people} /></div>
          </div>
        ))}
      </div>
      <MentionBox people={people} placeholder="Reply" onSend={(body, mentions) => onReply(t.root, body, mentions)} />
    </div>
  );
}

// The pins, the open thread, and placing a new comment.
export function CommentsLayer({ api, threads, adding, setAdding, openId, setOpenId, people, onAdd, onReply, onResolve, onHide, showResolved, view }) {
  const [draft, setDraft] = useState(null);   // {x, y, element_id, ox, oy}
  const layer = useRef(null);
  useEffect(() => { if (!adding) setDraft(null); }, [adding]);
  if (!api) return null;
  const st = api.getAppState();
  const toScreen = (p) => {
    const v = sceneCoordsToViewportCoords({ sceneX: p.x, sceneY: p.y }, st);
    return { left: v.x - st.offsetLeft, top: v.y - st.offsetTop };
  };
  function place(e) {
    if (!adding || draft) return;
    const p = viewportCoordsToSceneCoords({ clientX: e.clientX, clientY: e.clientY }, st);
    const hit = itemAt(api, p);
    setDraft(hit ? { x: p.x, y: p.y, element_id: hit.id, ox: p.x - hit.x, oy: p.y - hit.y } : { x: p.x, y: p.y });
  }
  const shown = threads.filter(t => showResolved || !t.root.resolved_at);
  let n = 0;
  return (
    <div ref={layer} className={'comments-layer' + (adding ? ' adding' : '')} onClick={place} data-v={view}
      {...(adding && !draft ? { role: 'button', 'aria-label': 'Click a spot on the board to comment there' } : {})}>
      {shown.map(t => {
        n++;
        const spot = spotOf(api, t.root); if (!spot) return null;
        const pos = toScreen(spot);
        const open = openId === t.root.id;
        return (
          <React.Fragment key={t.root.id}>
            <button className={'pin' + (t.root.resolved_at ? ' resolved' : '') + (open ? ' open' : '')} style={pos}
              onClick={e => { e.stopPropagation(); setOpenId(open ? null : t.root.id); }} title={nameOf(t.root.author) + ': ' + t.root.body}>
              {n}
            </button>
            {open && (
              <div className="pop-at" style={{ left: pos.left + 22, top: pos.top - 6 }}>
                <Thread t={t} people={people} canResolve={store.canEdit || t.root.author === (store.email || 'you')}
                  onReply={onReply} onResolve={onResolve} onHide={onHide} onClose={() => setOpenId(null)} />
              </div>
            )}
          </React.Fragment>
        );
      })}
      {draft && (() => {
        const pos = toScreen(draft);
        return (
          <>
            <span className="pin draft" style={pos}>+</span>
            <div className="pop-at" style={{ left: pos.left + 22, top: pos.top - 6 }} onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
              <div className="thread">
                <div className="thread-head"><span>New comment</span><button className="x" onClick={() => { setDraft(null); setAdding(false); }} aria-label="Cancel">×</button></div>
                <MentionBox autoFocus people={people} onSend={async (body, mentions) => {
                  const d = draft; setDraft(null); setAdding(false);
                  await onAdd({ body, mentions, element_id: d.element_id || null, x: d.element_id ? d.ox : d.x, y: d.element_id ? d.oy : d.y });
                }} />
              </div>
            </div>
          </>
        );
      })()}
    </div>
  );
}

// The list of every thread on the board.
export function CommentsPanel({ api, threads, people, showResolved, setShowResolved, onPick, onClose }) {
  const open = threads.filter(t => !t.root.resolved_at);
  const list = showResolved ? threads : open;
  return (
    <aside className="side-panel" onPointerDown={e => e.stopPropagation()}>
      <div className="side-head">
        <span>Comments {open.length ? `(${open.length} open)` : ''}</span>
        <button className="x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <label className="side-toggle"><input type="checkbox" checked={showResolved} onChange={e => setShowResolved(e.target.checked)} /> Show resolved</label>
      {list.length === 0 && <div className="side-empty">{threads.length ? 'Everything is resolved.' : 'No comments yet. Click Comment, then a spot on the board.'}</div>}
      {list.map(t => {
        const gone = !spotOf(api, t.root);
        return (
          <button key={t.root.id} className={'side-item' + (t.root.resolved_at ? ' resolved' : '')} onClick={() => onPick(t)}>
            <div className="msg-meta"><b>{nameOf(t.root.author)}</b> · {ago(t.root.created_at)}{t.replies.length ? ` · ${t.replies.length} repl${t.replies.length > 1 ? 'ies' : 'y'}` : ''}</div>
            <div className="msg-body"><Body text={t.root.body} people={people} /></div>
            {gone && <small className="muted">The item it was on was removed.</small>}
          </button>
        );
      })}
    </aside>
  );
}
