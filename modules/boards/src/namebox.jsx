// A name, asked for inside Boards (not the browser's own pop-up box).
import React, { useState } from 'react';

export function NameBox({ title, initial = '', onDone }) {
  const [v, setV] = useState(initial);
  const ok = () => onDone(v.trim() || initial || '');
  return (
    <div className="modal-wrap" onClick={() => onDone(null)}>
      <div className="modal name-modal" onClick={e => e.stopPropagation()}>
        <h2>{title}</h2>
        <input autoFocus className="field" value={v} onFocus={e => e.target.select()} onChange={e => setV(e.target.value)}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') ok(); if (e.key === 'Escape') onDone(null); }} />
        <div className="modal-foot">
          <button className="ghost" onClick={() => onDone(null)}>Cancel</button>
          <button className="solid" onClick={ok}>Done</button>
        </div>
      </div>
    </div>
  );
}
