// Sharing (Build 660): who sees a board, and a view-only link for people
// outside VENIA OS (a buyer, a factory).
//
// The database decides who sees what (venia_board_role and the policies in
// 20261119_venia_board_sharing.sql); this panel only asks it and changes the
// setting. A view link is read through the board-view function, which hands
// back the board's drawing and ten-minute picture addresses, never a key.
import React, { useEffect, useMemo, useState } from 'react';
import { Excalidraw, restoreElements } from '@excalidraw/excalidraw';
import { store, nameOf, blobToDataURL } from './store.js';
import { makeRenderCard, isCardUrl } from './cards.jsx';

const EVERYONE = [
  ['edit', 'Can edit'],
  ['view', 'Can view'],
  ['none', 'No access'],
];
const ENDS = [
  [0, 'No end date'],
  [1, 'Ends in 1 day'],
  [7, 'Ends in 7 days'],
  [30, 'Ends in 30 days'],
];
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// A short line for the board's top bar: who can see it.
export function shareLabel(s) {
  if (!s) return '';
  const n = s.people.length;
  if (s.everyone === 'edit') return 'Everyone can edit';
  if (s.everyone === 'view') return n ? 'Everyone can view, ' + n + ' can edit' : 'Everyone can view';
  return n ? 'Shared with ' + n : 'Private';
}

export function SharePanel({ boardId, title, onClose, onChange }) {
  const [s, setS] = useState(null);
  const [people, setPeople] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState('');
  const [addRole, setAddRole] = useState('edit');
  const [ends, setEnds] = useState(7);
  const [copied, setCopied] = useState('');

  const load = async () => {
    try { const v = await store.sharing(boardId); setS(v); onChange && onChange(v); }
    catch (e) { setErr('Couldn’t read who this board is shared with.'); }
  };
  useEffect(() => { load(); store.people().then(setPeople).catch(() => {}); }, [boardId]);

  const mine = s && (s.owner === store.email || (!s.owner && store.role === 'owner'));
  const others = useMemo(() => {
    if (!s) return [];
    const taken = new Set([s.owner, ...s.people.map(p => p.email)]);
    return people.filter(p => !taken.has(p.email));
  }, [people, s]);

  const run = async (fn, fail) => {
    setBusy(true); setErr('');
    try { await fn(); await load(); } catch (e) { setErr(fail); }
    setBusy(false);
  };
  const copy = async (token) => {
    const url = store.viewLinkUrl(token);
    try { await navigator.clipboard.writeText(url); setCopied(token); setTimeout(() => setCopied(''), 2000); }
    catch (e) { window.prompt('Copy this link', url); }
  };

  return (
    <div className="modal-wrap" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal sh-modal" role="dialog" aria-label="Share this board">
        <div className="vp-head">
          <h2>Share “{title || 'Board'}”</h2>
          <button className="link" onClick={onClose}>Close</button>
        </div>
        {!s && !err && <div className="side-empty">Looking…</div>}
        {err && <div className="sh-err">{err}</div>}
        {s && (
          <>
            {!mine && <p className="sh-note">Only {nameOf(s.owner) || 'the person who made it'} can change who sees this board.</p>}

            <div className="sh-row sh-owner">
              <span className="sh-who"><b>{nameOf(s.owner) || 'Owner'}</b><small>{s.owner}</small></span>
              <span className="sh-role">Owner</span>
            </div>

            <div className="sh-row">
              <span className="sh-who"><b>Everyone in VENIA OS</b><small>Everyone who has Boards</small></span>
              {mine ? (
                <select value={s.everyone} disabled={busy} aria-label="Everyone in VENIA OS"
                  onChange={e => { const v = e.target.value; run(() => store.setEveryone(boardId, v), 'Couldn’t change that just now.'); }}>
                  {EVERYONE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              ) : <span className="sh-role">{(EVERYONE.find(x => x[0] === s.everyone) || [])[1]}</span>}
            </div>

            {s.people.map(p => (
              <div className="sh-row" key={p.email}>
                <span className="sh-who"><b>{nameOf(p.email)}</b><small>{p.email}</small></span>
                {mine ? (
                  <span className="sh-ctl">
                    <select value={p.role} disabled={busy} aria-label={'What ' + nameOf(p.email) + ' can do'}
                      onChange={e => { const v = e.target.value; run(() => store.sharePerson(boardId, p.email, v), 'Couldn’t change that just now.'); }}>
                      <option value="edit">Can edit</option>
                      <option value="view">Can view</option>
                    </select>
                    <button className="link quiet" disabled={busy} onClick={() => run(() => store.unsharePerson(boardId, p.email), 'Couldn’t remove them just now.')}>Remove</button>
                  </span>
                ) : <span className="sh-role">{p.role === 'edit' ? 'Can edit' : 'Can view'}</span>}
              </div>
            ))}

            {mine && (
              <div className="sh-add">
                <select value={adding} onChange={e => setAdding(e.target.value)} aria-label="Person to add">
                  <option value="">{others.length ? 'Add a person…' : 'Everyone with Boards is here'}</option>
                  {others.map(p => <option key={p.email} value={p.email}>{p.name} ({p.email})</option>)}
                </select>
                <select value={addRole} onChange={e => setAddRole(e.target.value)} aria-label="What they can do">
                  <option value="edit">Can edit</option>
                  <option value="view">Can view</option>
                </select>
                <button className="solid sm" disabled={!adding || busy}
                  onClick={() => { const who = adding; run(async () => { await store.sharePerson(boardId, who, addRole); setAdding(''); }, 'Couldn’t add them just now.'); }}>Add</button>
              </div>
            )}
            {mine && s.everyone !== 'none' && (
              <p className="sh-note">Turn “Everyone in VENIA OS” to No access to keep this board to just the people above.</p>
            )}

            {mine && (
              <div className="sh-links">
                <h3>View-only link</h3>
                <p className="sh-note">Anyone with the link can look at this board, no sign-in needed. They can’t change it, comment or see other boards.</p>
                {s.links.map(l => (
                  <div className="sh-row" key={l.token}>
                    <span className="sh-who"><b>Link made {day(l.created_at)}</b><small>{l.expires_at ? 'Works until ' + day(l.expires_at) : 'No end date'}</small></span>
                    <span className="sh-ctl">
                      <button className="solid sm" onClick={() => copy(l.token)}>{copied === l.token ? 'Copied' : 'Copy link'}</button>
                      <button className="link quiet" disabled={busy} onClick={() => run(() => store.turnOffViewLink(l.token), 'Couldn’t turn it off just now.')}>Turn off</button>
                    </span>
                  </div>
                ))}
                <div className="sh-add">
                  <select value={ends} onChange={e => setEnds(Number(e.target.value))} aria-label="When the link stops working">
                    {ENDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <button className="solid sm" disabled={busy}
                    onClick={() => run(async () => { const l = await store.makeViewLink(boardId, ends); await copy(l.token); }, 'Couldn’t make a link just now.')}>Make a link</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// The page a view link opens: the board, view-only, nothing else.
export function ViewOnly({ token }) {
  const [state, setState] = useState({ phase: 'loading' });
  useEffect(() => {
    let live = true;
    document.title = 'Board';
    (async () => {
      try {
        const d = await store.openViewLink(token);
        if (!live) return;
        if (d.gone) { setState({ phase: 'gone' }); return; }
        const files = [];
        await Promise.all((d.files || []).map(async f => {
          try {
            const blob = await (await fetch(f.url)).blob();
            files.push({ id: f.id, dataURL: await blobToDataURL(blob), mimeType: f.mime || blob.type, created: Date.now() });
          } catch (e) { /* one missing picture never blocks the board */ }
        }));
        // board cards here are pictures only: they don't open other boards
        const raw = (d.elements || []).map(e => (e && e.customData && e.customData.kind === 'board') ? { ...e, link: null } : e);
        const elements = restoreElements(raw, null);
        if (!live) return;
        document.title = (d.title || 'Board') + ' · View only';
        setState({ phase: 'ready', title: d.title, initial: {
          elements, files,
          appState: { viewBackgroundColor: d.background || '#F7F6F2', viewModeEnabled: true },
          scrollToContent: true,
        } });
      } catch (e) { if (live) setState({ phase: 'error' }); }
    })();
    return () => { live = false; };
  }, [token]);

  const renderCard = useMemo(() => makeRenderCard(() => null, false), []);
  if (state.phase === 'loading') return <div className="empty">Opening the board…</div>;
  if (state.phase === 'gone') return <div className="empty">This link has been turned off or has ended. Ask whoever sent it for a new one.</div>;
  if (state.phase === 'error') return <div className="empty">Couldn’t open the board just now. Try again in a moment.</div>;
  return (
    <div className="view-only">
      <div className="vo-bar"><b>{state.title || 'Board'}</b><span className="vo-badge">View only</span></div>
      <div className="vo-canvas">
        <Excalidraw
          initialData={state.initial}
          viewModeEnabled
          renderEmbeddable={renderCard}
          validateEmbeddable={url => (isCardUrl(url) ? true : undefined)}
          langCode="en"
          name={state.title || 'Board'}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false, export: false, clearCanvas: false, changeViewBackgroundColor: false, saveAsImage: false } }}
        />
      </div>
    </div>
  );
}
