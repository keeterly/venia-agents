// The module's contract with whatever hosts it. Inside VENIA OS it runs in a
// frame and tells the shell its title; on its own (/boards) it shows its own
// way back. Nothing here reaches into the shell's code.
export const inHost = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();

export function tellHost(type, payload) {
  if (!inHost) return;
  try { window.parent.postMessage({ source: 'venia-module', module: 'brainstorm.boards', type, payload }, window.location.origin); } catch (e) {}
}

// Ask the shell something and wait for its answer (or null after a while).
let askN = 0;
export function askHost(type, payload, ms = 6000) {
  if (!inHost) return Promise.resolve(null);
  const req = 'q' + (++askN) + Date.now().toString(36);
  return new Promise(done => {
    const got = (ev) => {
      if (ev.origin !== window.location.origin || !ev.data || ev.data.source !== 'venia-host' || ev.data.type !== type) return;
      const p = ev.data.payload;
      if (p && p.req && p.req !== req) return;
      clearTimeout(t); window.removeEventListener('message', got); done(p || null);
    };
    const t = setTimeout(() => { window.removeEventListener('message', got); done(null); }, ms);
    window.addEventListener('message', got);
    tellHost(type, { ...(payload || {}), req });
  });
}
