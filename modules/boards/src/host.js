// The module's contract with whatever hosts it. Inside VENIA OS it runs in a
// frame and tells the shell its title; on its own (/boards) it shows its own
// way back. Nothing here reaches into the shell's code.
export const inHost = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();

export function tellHost(type, payload) {
  if (!inHost) return;
  try { window.parent.postMessage({ source: 'venia-module', module: 'brainstorm.boards', type, payload }, window.location.origin); } catch (e) {}
}
