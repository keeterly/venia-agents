import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { store } from './store.js';
import { inHost, tellHost } from './host.js';
import { TEMPLATES, templateElements, legacyCardElements, boardCard } from './elements.js';
import Board from './Board.jsx';
import { NameBox } from './namebox.jsx';
import { ImportSheet } from './importer.jsx';
import { ViewOnly } from './share.jsx';
import { FROM_BRAINSTORM, syncFromBrainstorm } from './frombrainstorm.js';

// Who sees a board, in a word or two on its card (Build 661).
function accessTag(b) {
  if (store.mode !== 'cloud' || !b.everyone) return '';
  const mine = String(b.owner || b.created_by || '').toLowerCase() === store.email;
  if (!mine) return b.everyone === 'edit' ? '' : 'Shared with you';
  if (b.everyone === 'edit') return '';
  if (b.everyone === 'view') return 'Everyone can view';
  return b.shared_with ? 'Shared with ' + b.shared_with : 'Private';
}

export const LEGACY_ID = 'b-brainstorm-board';
const FROM_IDS = new Set(FROM_BRAINSTORM.map(f => f.id));

function useRoute() {
  const read = () => {
    const m = (window.location.hash || '').match(/^#\/b\/([\w-]+)(?:\/c\/([\w-]+))?(?:\/f\/([^/]+))?/);
    // "#/v/…": a view-only link someone was sent (Build 661)
    const v = (window.location.hash || '').match(/^#\/v\/([a-f0-9]{32})\b/);
    if (v) return { view: 'viewonly', token: v[1] };
    if (m) { let find = null; try { find = m[3] ? decodeURIComponent(m[3]) : null; } catch (e) {} return { view: 'board', id: m[1], comment: m[2] || null, find }; }
    // "#/import/…": another part of VENIA OS sent styles or a photo (Build 650).
    if (/^#\/import\b/.test(window.location.hash || '')) return { view: 'import', key: window.location.hash };
    // "#/new": VENIA OS's Today asked for a new board straight away.
    return { view: 'home', fresh: /^#\/new\b/.test(window.location.hash || '') };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => { const f = () => setRoute(read()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return route;
}
export const go = (hash) => { window.location.hash = hash; };

// The words around a search match on a board, so you can see what matched.
function snippet(text, term, title) {
  const t = String(text || ''); const body = title && t.startsWith(title) ? t.slice(title.length) : t;
  const i = body.toLowerCase().indexOf(term.toLowerCase()); if (i < 0) return '';
  const a = Math.max(0, i - 30), z = Math.min(body.length, i + term.length + 50);
  return (a > 0 ? '…' : '') + body.slice(a, z).trim() + (z < body.length ? '…' : '');
}

export default function App() {
  const route = useRoute();
  if (route.view === 'viewonly') return <ViewOnly token={route.token} />;
  if (route.view === 'import') return <ImportSheet key={route.key} go={go} />;
  return route.view === 'board'
    ? <Board key={route.id} boardId={route.id} commentId={route.comment} find={route.find} />
    : <Home fresh={route.fresh} />;
}

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  if (s < 86400 * 30) return Math.round(s / 86400) + ' d ago';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Bring the old Brainstorm Board across the first time Boards opens.
async function ensureLegacyBoard(boards) {
  if (store.mode !== 'cloud' || !store.canEdit) return false;
  if (boards.some(b => b.id === LEGACY_ID)) return false;
  const trashed = await store.listBoards({ trash: true });
  if (trashed.some(b => b.id === LEGACY_ID)) return false;
  if (await store.wasPurged(LEGACY_ID)) return false;
  const cards = await store.legacyBoardCards();
  if (!cards.length) return false;
  const elements = cards.filter(c => c.kind !== 'img').flatMap(legacyCardElements);
  // Created with a fixed id so it's made once; photos are fetched when the
  // board first opens (they need their bytes).
  const row = {
    title: 'Brainstorm board', parent_id: null,
    scene: { elements, appState: {}, legacyPending: cards.filter(c => c.kind === 'img') },
  };
  // Brainstorm is shared across the brand, so its board starts shared too (Build 663).
  try { await store.createBoard({ ...row, id: LEGACY_ID, everyone: 'edit' }); return true; } catch (e) { return false; }
}

function Home({ fresh = false }) {
  const [boards, setBoards] = useState(null);
  const [trash, setTrash] = useState(false);
  const [q, setQ] = useState('');
  const [thumbs, setThumbs] = useState({});
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState(null);
  const [waiting, setWaiting] = useState([]);
  const [err, setErr] = useState('');
  const [pins, setPins] = useState(new Set());
  const [moving, setMoving] = useState(null);     // board being moved into another
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [asking, setAsking] = useState(null);       // the name box: { title, initial, done }
  const askName = (title, initial) => new Promise(done => setAsking({ title, initial, done }));

  // Opened as "#/new": show the New board sheet, then tidy the address so a
  // reload or Back doesn't ask again.
  useEffect(() => {
    if (!fresh) return;
    if (store.canEdit) setCreating(true);
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) {}
  }, [fresh]);

  // Only the newest load may show: flipping to Trash and back quickly must not
  // leave the slower, older list on screen.
  // no board is open on the list
  store.boardRole = null;
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++loadSeq.current;
    const stale = () => mine !== loadSeq.current;
    try {
      let list = await store.listBoards({ trash });
      if (!trash && await ensureLegacyBoard(list)) list = await store.listBoards();
      if (!trash && await syncFromBrainstorm(list)) list = await store.listBoards();
      if (stale()) return;
      setBoards(list);
      const th = await store.thumbs(list.map(b => b.id)); if (stale()) return; setThumbs(th);
      const pn = await store.pins().catch(() => new Set()); if (stale()) return; setPins(pn);
      if (!trash) { const w = await store.localBoardsWaiting(); if (!stale()) setWaiting(w); }
    } catch (e) { if (!stale()) { setErr(String(e.message || e)); setBoards([]); } }
  }, [trash]);
  useEffect(() => { load(); tellHost('boards:title', { title: 'Boards' }); document.title = 'Boards · VENIA OS'; }, [load]);

  // Look at the sign-in again when it changes or the app comes back to the
  // front, so a phone that opened Boards mid-renewal catches up by itself.
  // (Only here on the list, never under an open board.)
  const [, setModeTick] = useState(0);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => {
    let checking = false, alive = true;
    const recheck = async (why) => {
      if (checking) return;
      const was = store.mode + ':' + store.email;
      const stuck = store.mode === 'local' && store.reason !== 'not-set-up';
      if (!stuck && !(why === 'SIGNED_OUT' && store.mode === 'cloud')) return;
      checking = true;
      try { await store.init(); } finally { checking = false; }
      if (!alive) return;
      if (store.mode + ':' + store.email !== was) { setModeTick(t => t + 1); setErr(''); loadRef.current(); }
    };
    recheck('open');
    const off = store.onSignInChange(recheck);
    return () => { alive = false; off(); };
  }, []);

  const byId = useMemo(() => Object.fromEntries((boards || []).map(b => [b.id, b])), [boards]);
  const shown = useMemo(() => {
    if (!boards) return [];
    const term = q.trim().toLowerCase();
    if (term) return boards.filter(b => (b.title + ' ' + (b.search_text || '')).toLowerCase().includes(term));
    if (trash) return boards;
    return boards.filter(b => (!b.parent_id || !byId[b.parent_id]) && !FROM_IDS.has(b.id));
  }, [boards, q, trash, byId]);
  // Brainstorm's maps, together above your own boards (Build 663).
  const fromBrainstorm = useMemo(() => (trash || q.trim() || !boards) ? []
    : FROM_BRAINSTORM.map(f => byId[f.id] && !byId[f.id].trashed_at ? { ...byId[f.id], blurb: f.blurb } : null).filter(Boolean), [boards, trash, q, byId]);
  const pinned = useMemo(() => (trash || q.trim() || !boards) ? [] : boards.filter(b => pins.has(b.id)), [boards, pins, trash, q]);

  async function moveInto(child, parentId) {
    setMoving(null); setDragId(null); setOverId(null);
    if (!child || child.id === parentId) return;
    try { await store.moveInto(child.id, parentId, boardCard); load(); }
    catch (e) { setErr(String(e.message || e)); }
  }
  const childCount = (id) => (boards || []).filter(b => b.parent_id === id).length;

  async function act(kind, b) {
    setMenu(null);
    try {
      if (kind === 'rename') { const t = await askName('Rename board', b.title); if (t && t.trim() && t.trim() !== b.title) await store.rename(b.id, t.trim()); }
      if (kind === 'trash') await store.trash(b.id);
      if (kind === 'restore') await store.restore(b.id);
      if (kind === 'purge') { if (window.confirm(`Delete "${b.title}" for good? Its images go too. This can't be undone.`)) await store.purge(b.id); }
      if (kind === 'top') { await store.moveInto(b.id, null, boardCard); }
      if (kind === 'pin' || kind === 'unpin') await store.setPin(b.id, kind === 'pin');
      if (kind === 'move') { setMoving(b); return; }
      load();
    } catch (e) { setErr(String(e.message || e)); }
  }


  function renderCard(b, prefix) {
    return (
            <div key={prefix + b.id} className={'card' + (overId === b.id && dragId && dragId !== b.id ? ' drop' : '')}
              onClick={() => !trash && go('/b/' + b.id + (q.trim() && !(b.title || '').toLowerCase().includes(q.trim().toLowerCase()) ? '/f/' + encodeURIComponent(q.trim()) : ''))}
              draggable={!trash && store.canEdit}
              onDragStart={e => { setDragId(b.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', b.id); }}
              onDragEnd={() => { setDragId(null); setOverId(null); }}
              onDragOver={e => { if (dragId && dragId !== b.id) { e.preventDefault(); setOverId(b.id); } }}
              onDragLeave={() => setOverId(o => o === b.id ? null : o)}
              onDrop={e => { e.preventDefault(); const c = byId[dragId]; if (c) moveInto(c, b.id); }}>
              <div className="thumb">{thumbs[b.id] && b.item_count !== 0 ? <img src={thumbs[b.id]} alt="" /> : <span className="thumb-empty">{(b.title || '?').slice(0, 1)}</span>}</div>
              <div className="card-foot">
                <div className="card-title">{pins.has(b.id) && <span className="pin-mark" title="Pinned">●</span>}{b.title}</div>
                {q.trim() && (() => { const s = snippet(b.search_text, q.trim(), b.title); return s ? <div className="card-hit">{s}</div> : null; })()}
                {b.blurb && <div className="card-hit">{b.blurb}</div>}
                <div className="card-meta">
                  {b.parent_id && byId[b.parent_id] && q ? <>in {byId[b.parent_id].title} · </> : null}
                  {b.item_count || 0} item{b.item_count === 1 ? '' : 's'}
                  {childCount(b.id) ? <> · {childCount(b.id)} board{childCount(b.id) > 1 ? 's' : ''} inside</> : null}
                  {' · '}{ago(b.updated_at)}
                  {accessTag(b) ? <> · <span className="card-access">{accessTag(b)}</span></> : null}
                </div>
              </div>
              {store.canEdit && <button className="card-menu" onClick={e => { e.stopPropagation(); setMenu(menu === prefix + b.id ? null : prefix + b.id); }} aria-label="Board options">⋯</button>}
              {menu === prefix + b.id && (
                <div className="menu" onClick={e => e.stopPropagation()}>
                  {trash ? (<>
                    <button onClick={() => act('restore', b)}>Restore</button>
                    {store.role === 'owner' && <button className="danger" onClick={() => act('purge', b)}>Delete for good</button>}
                  </>) : (<>
                    <button onClick={() => act(pins.has(b.id) ? 'unpin' : 'pin', b)}>{pins.has(b.id) ? 'Unpin' : 'Pin to the top'}</button>
                    <button onClick={() => act('rename', b)}>Rename</button>
                    <button onClick={() => act('move', b)}>Move into a board…</button>
                    {b.parent_id && <button onClick={() => act('top', b)}>Move to top level</button>}
                    <button className="danger" onClick={() => act('trash', b)}>Move to Trash</button>
                  </>)}
                </div>
              )}
            </div>
    );
  }

  return (
    <div className="home">
      <header className="home-head">
        <div className="home-brand">
          {!inHost && <a className="back-os" href="/">VENIA <span>OS</span></a>}
          <h1>Boards</h1>
        </div>
        <div className="home-tools">
          <input className="search" placeholder="Search boards and what's on them" value={q} onChange={e => setQ(e.target.value)} />
          <button className={'ghost' + (trash ? ' on' : '')} onClick={() => setTrash(t => !t)}>{trash ? 'Back to boards' : 'Trash'}</button>
          {!trash && store.canEdit && <button className="solid" onClick={() => setCreating(true)}>New board</button>}
        </div>
      </header>

      {store.mode === 'local' && (
        <div className="note-bar">
          {store.reason === 'signed-out' ? 'You\'re not signed in to VENIA OS here, so boards are saved on this device only.'
            : store.reason === 'not-set-up' ? 'Cloud saving for Boards isn\'t switched on yet, so boards are saved on this device for now.'
            : 'Can\'t reach the cloud right now, so boards are saved on this device.'}
        </div>
      )}
      {waiting.length > 0 && (
        <div className="note-bar">
          {waiting.length} board{waiting.length > 1 ? 's' : ''} saved on this device before cloud saving was on.
          <button className="link" disabled={uploading} onClick={async () => {
            if (uploading) return; setUploading(true); setErr('');
            try { await store.uploadLocalBoards(); } catch (e) { setErr('Couldn\'t move every board to the cloud: ' + (e.message || e) + ' The rest are still on this device; try again.'); }
            setUploading(false); load();
          }}>{uploading ? 'Moving…' : 'Move to the cloud'}</button>
        </div>
      )}
      {err && <div className="note-bar warn">{err}</div>}

      {fromBrainstorm.length > 0 && (<>
        <div className="section-label">From Brainstorm <span className="section-sub">Brainstorm's maps, kept here. New goals and notes are added each time Boards opens.</span></div>
        <div className="grid">{fromBrainstorm.map(b => renderCard(b, 'bs:'))}</div>
        <div className="section-label">Your boards</div>
      </>)}
      {boards === null ? <div className="empty">Opening…</div> : shown.length === 0 && !fromBrainstorm.length ? (
        <div className="empty">
          {trash ? 'Trash is empty.' : q ? 'No board matches that.' : (
            <>
              <p>Collect images, sketch, write and group ideas on an endless canvas.</p>
              {store.canEdit && <button className="solid" onClick={() => setCreating(true)}>Start a board</button>}
            </>
          )}
        </div>
      ) : (
        <>
          {pinned.length > 0 && (<>
            <div className="section-label">Pinned</div>
            <div className="grid">{pinned.map(b => renderCard(b, 'p:'))}</div>
            <div className="section-label">All boards</div>
          </>)}
          <div className="grid">{shown.map(b => renderCard(b, ''))}</div>
        </>
      )}
      {creating && <NewBoard onClose={() => setCreating(false)} />}
      {asking && <NameBox title={asking.title} initial={asking.initial} onDone={v => { const d = asking.done; setAsking(null); d(v); }} />}
      {moving && <MoveInto board={moving} boards={boards || []} onPick={pid => moveInto(moving, pid)} onClose={() => setMoving(null)} />}
      {dragId && <div className="drag-hint">Drop it on a board to put it inside</div>}
    </div>
  );
}

export function NewBoard({ onClose, parentId = null, onCreated }) {
  const [title, setTitle] = useState('');
  const [tpl, setTpl] = useState('blank');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  async function make() {
    if (busyRef.current) return;   // Enter pressed twice makes one board
    busyRef.current = true;
    setBusy(true);
    try {
      const name = title.trim() || (tpl === 'blank' ? 'Untitled board' : TEMPLATES.find(t => t.id === tpl).name);
      const elements = templateElements(tpl, name);
      const row = await store.createBoard({ title: name, parent_id: parentId, scene: { elements, appState: {} } });
      if (onCreated) onCreated(row); else go('/b/' + row.id);
      onClose();
    } catch (e) { alert('Couldn\'t create the board: ' + (e.message || e)); busyRef.current = false; setBusy(false); }
  }
  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>{parentId ? 'New board inside this one' : 'New board'}</h2>
        <input autoFocus className="field" placeholder="Name it (SS28 mood, Shoot in Joshua Tree…)" value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && make()} />
        <div className="tpls">
          {TEMPLATES.map(t => (
            <button key={t.id} className={'tpl' + (tpl === t.id ? ' on' : '')} onClick={() => setTpl(t.id)}>
              <span className="tpl-name">{t.name}</span><span className="tpl-blurb">{t.blurb}</span>
            </button>
          ))}
        </div>
        <div className="modal-foot">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="solid" disabled={busy} onClick={make}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </div>
    </div>
  );
}

// Pick the board to put one inside. Not itself, and not anything inside it.
function MoveInto({ board, boards, onPick, onClose }) {
  const [q, setQ] = useState('');
  const inside = new Set([board.id]);
  let grew = true;
  while (grew) { grew = false; for (const b of boards) if (b.parent_id && inside.has(b.parent_id) && !inside.has(b.id)) { inside.add(b.id); grew = true; } }
  const by = Object.fromEntries(boards.map(b => [b.id, b]));
  const path = (b) => { const t = []; let p = b.parent_id, g = 0; while (p && by[p] && g++ < 12) { t.unshift(by[p].title); p = by[p].parent_id; } return t.join(' / '); };
  const list = boards.filter(b => !inside.has(b.id) && b.id !== board.parent_id && (b.title + ' ' + path(b)).toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>Move "{board.title}" into</h2>
        <input autoFocus className="field" placeholder="Find a board" value={q} onChange={e => setQ(e.target.value)} />
        <div className="pick-list">
          {list.map(b => <button key={b.id} onClick={() => onPick(b.id)}><b>{b.title}</b>{path(b) && <small>in {path(b)}</small>}</button>)}
          {!list.length && <div className="side-empty">No other board to put it in.</div>}
        </div>
        <div className="modal-foot"><button className="ghost" onClick={onClose}>Cancel</button></div>
      </div>
    </div>
  );
}
