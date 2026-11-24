// Build 740: replays the Nov 23 wipe against the merge and the wipe guard.
// Run: node scripts/check-wipe-guard.js venia-control-panel-v1.html
const fs = require('fs'), vm = require('vm');
const s = fs.readFileSync(process.argv[2] || 'venia-control-panel-v1.html', 'utf8');
const cut = (a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); if (i < 0 || j < 0) throw new Error('marker ' + a); return s.slice(i, j + b.length); };
const guard = cut('// ══ WIPE GUARD (Build 740)', '// ══ end WIPE GUARD');
const merge = cut('// ── 3-way merge for cross-device sync', 'window.mergeSnapshots = mergeSnapshots;');
const store = {};
const ctx = { console, Date, JSON, Object, Array, String, Number, Math,
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } } };
ctx.window = ctx;
ctx.window.SYNC_KEYS = ['styles','materials','vendors','bom','pom','pos','dump','dumpPlan','prPulls','activityLog'];
vm.createContext(ctx);
vm.runInContext('var STATE = {}; ' + guard + '\n' + merge + '\n; this.STATE = STATE;', ctx);
const run = c => vm.runInContext(c, ctx);
let fail = 0; const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail = 1; };

// The Nov 23 night: base full (sessionStorage of a reloaded tab), local = empty defaults, cloud full.
const full = { styles: [{id:'S1',name:'Eclipse'},{id:'S2',name:'Hamlet'}], materials:[{id:'M1'}], vendors:[{id:'V1'}],
  bom: {S1:[{id:'b1',qty:3}]}, pom: {S1:[{id:'p1'}]}, pos:[{id:'PO1'}], dump:[{id:'d1',t:'idea'}], dumpPlan:{at:'x'}, prPulls:[{id:'PR1'}], activityLog:[] };
const empty = { styles:[], materials:[], vendors:[], bom:{}, pom:{}, dump:[], dumpPlan:null, prPulls:[], activityLog:[] }; // pos absent, as in the literal
ctx.full = JSON.parse(JSON.stringify(full)); ctx.empty = JSON.parse(JSON.stringify(empty));
run('STATE._tomb = {}; window.__m = mergeSnapshots(JSON.parse(JSON.stringify(full)), empty, full);');
const m0 = run('window.__m');
ok('without the guard the old merge empties styles (reproduces the wipe)', m0.styles.length === 0 && m0.prPulls.length === 0);
run('STATE._tomb = {}; var tb = veniaTombKeys(); window.__m = mergeSnapshots(JSON.parse(JSON.stringify(full)), empty, full); window.__kept = veniaKeepNonEmpty(window.__m, full, tb, "test");');
const m1 = run('window.__m'), kept = run('window.__kept');
ok('guard puts back styles, materials, vendors, bom, pom, dump, dumpPlan, prPulls', ['styles','materials','vendors','bom','pom','dump','dumpPlan','prPulls'].every(k => kept.includes(k)));
ok('styles back to 2', m1.styles.length === 2);
ok('pos untouched (was never at risk)', m1.pos.length === 1);
ok('tombstones written by the bad merge taken back', Object.keys(run('STATE._tomb')).filter(k => /^(S1|S2|M1|V1|PR1|d1)$/.test(k)).length === 0);

// A person deletes one style: still goes through.
run('STATE._tomb = {}; var tb2 = veniaTombKeys(); var loc = JSON.parse(JSON.stringify(full)); loc.styles = [loc.styles[0]]; window.__m = mergeSnapshots(JSON.parse(JSON.stringify(full)), loc, full); window.__k2 = veniaKeepNonEmpty(window.__m, full, tb2, "t");');
ok('deleting one style still works', run('window.__m.styles.length') === 1 && run('window.__k2.length') === 0);

// A person clears Brainstorm on this device: save() marks it, so the merge may empty it.
run('window.__veniaBooted = true; window.__vApplyingRemote = false; STATE = Object.assign(STATE, JSON.parse(JSON.stringify(full))); veniaNoteEmptied(true); STATE.dump = []; veniaNoteEmptied(false);');
ok('clearing dump by hand is marked', run('veniaEmptyOk("dump")') === true);
run('STATE._tomb = {}; var tb3 = veniaTombKeys(); var loc3 = JSON.parse(JSON.stringify(full)); loc3.dump = []; window.__m = mergeSnapshots(JSON.parse(JSON.stringify(full)), loc3, full); window.__k3 = veniaKeepNonEmpty(window.__m, full, tb3, "t");');
ok('a marked clear goes through', run('window.__m.dump.length') === 0 && !run('window.__k3').includes('dump'));

// A remote apply that empties dump is not marked.
store['venia-empty-ok'] = '{}';
run('STATE.dump = [{id:"d1"}]; veniaNoteEmptied(true); window.__vApplyingRemote = true; STATE.dump = []; veniaNoteEmptied(false); window.__vApplyingRemote = false;');
ok('an emptying applied from a sync is not marked', run('veniaEmptyOk("dump")') === false);

// Not booted: nothing marked.
run('window.__veniaBooted = false; STATE.styles = [{id:1}]; veniaNoteEmptied(true); STATE.styles = []; veniaNoteEmptied(false);');
ok('nothing is marked before the app has opened', run('veniaEmptyOk("styles")') === false);
// Stale mark expires.
store['venia-empty-ok'] = JSON.stringify({ styles: Date.now() - 4 * 864e5 });
ok('a mark older than 3 days no longer counts', run('veniaEmptyOk("styles")') === false);
process.exit(fail);
