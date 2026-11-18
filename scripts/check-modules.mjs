#!/usr/bin/env node
// VENIA OS module check (Build 609).
//
// The app is one file, but it is made of modules (MODULES in
// venia-control-panel-v1.html). This keeps them from growing back together
// while they are being pulled apart. It checks three things:
//
//   1. Every STATE key belongs to exactly one module.
//   2. Every module has a manifest (MODULE_MANIFEST) with the contract fields.
//   3. No module reads ANOTHER module's STATE keys in more places than it did
//      when the baseline was taken. Reads that move behind VeniaOS.get()
//      lower the count; run with --update to record the new, lower baseline.
//
// Usage:  node scripts/check-modules.mjs            (exit 1 on a problem)
//         node scripts/check-modules.mjs --update   (rewrite the baseline)
//         node scripts/check-modules.mjs --report   (print every cross-read)
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const APP = path.join(root, 'venia-control-panel-v1.html');
const MAP = JSON.parse(fs.readFileSync(path.join(here, 'module-map.json'), 'utf8'));
const BASE_FILE = path.join(here, 'module-baseline.json');
const args = new Set(process.argv.slice(2));
const src = fs.readFileSync(APP, 'utf8');
const lines = src.split('\n');
const problems = [];

// ── load MODULES and MODULE_MANIFEST exactly as the app defines them ──
function slice(startMark, endMark) {
  const a = src.indexOf(startMark), b = src.indexOf(endMark, a);
  if (a < 0 || b < 0) throw new Error('cannot find ' + startMark + ' … ' + endMark);
  return src.slice(a, b + endMark.length);
}
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(slice('const CATALOG_STYLE_FIELDS', 'window.MODULES = MODULES;') + '\nthis.MODULES = MODULES;', ctx);
let MANIFEST = null;
if (src.includes('const MODULE_MANIFEST')) {
  vm.runInContext(slice('const MODULE_MANIFEST', 'window.MODULE_MANIFEST = MODULE_MANIFEST;') + '\nthis.MODULE_MANIFEST = MODULE_MANIFEST;', ctx);
  MANIFEST = ctx.MODULE_MANIFEST;
}
const MODULES = ctx.MODULES;
const ids = Object.keys(MODULES);

// ── 1. partition ──
const owner = {};
ids.forEach(id => (MODULES[id].keys || []).forEach(k => {
  if (owner[k]) problems.push(`key "${k}" is owned by both ${owner[k]} and ${id}`);
  owner[k] = id;
}));

// ── 2. manifests ──
const FIELDS = ['tier', 'version', 'requires', 'uses', 'provides', 'emits', 'tables', 'server', 'mcp'];
const TIERS = ['core', 'base', 'addon'];
if (!MANIFEST) problems.push('MODULE_MANIFEST is missing');
else {
  ids.forEach(id => {
    const m = MANIFEST[id];
    if (!m) { problems.push(`module "${id}" has no manifest`); return; }
    FIELDS.forEach(f => { if (m[f] === undefined) problems.push(`manifest "${id}" is missing "${f}"`); });
    if (m.tier && !TIERS.includes(m.tier)) problems.push(`manifest "${id}" has unknown tier "${m.tier}"`);
    (m.requires || []).forEach(r => {
      const mod = String(r).split('.')[0];
      if (mod !== 'core') problems.push(`manifest "${id}" requires "${r}": a module may require only the core; use "uses" for another module`);
    });
  });
  Object.keys(MANIFEST).forEach(id => { if (!MODULES[id]) problems.push(`manifest "${id}" has no module in MODULES`); });
}

// ── 3. who reads whose data ──
const prefixOf = {};
Object.entries(MAP.prefixes).forEach(([mod, list]) => list.forEach(p => { prefixOf[p] = mod; }));
const prefixList = Object.keys(prefixOf).sort((a, b) => b.length - a.length);
function moduleForFn(name) {
  for (const p of prefixList) {
    if (name === p) return prefixOf[p];
    if (name.startsWith(p) && /[A-Z_0-9]/.test(name.charAt(p.length))) return prefixOf[p];
  }
  return null;
}
const anchorAt = [];
MAP.anchors.forEach(([text, mod]) => {
  const hits = [];
  lines.forEach((l, i) => { if (l.includes(text)) hits.push(i); });
  if (hits.length !== 1) problems.push(`anchor "${text}" matched ${hits.length} lines (needs exactly 1); update scripts/module-map.json`);
  else anchorAt.push([hits[0], mod]);
});
anchorAt.sort((a, b) => a[0] - b[0]);
const fnRe = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
const keyRe = /\bSTATE\.([A-Za-z_$][\w$]*)|\bSTATE\[\s*['"]([\w$]+)['"]\s*\]/g;
let fn = null, ai = -1, region = 'core';
const counts = {}, detail = {};
for (let i = 0; i < lines.length; i++) {
  while (ai + 1 < anchorAt.length && anchorAt[ai + 1][0] <= i) { ai++; region = anchorAt[ai][1]; }
  const m = fnRe.exec(lines[i]);
  if (m) fn = m[1]; else if (/^\S/.test(lines[i]) && !/^[}\])]/.test(lines[i]) && !/^\/\//.test(lines[i])) fn = null;
  const reader = (fn && moduleForFn(fn)) || region;
  if (reader === 'core') continue;
  let k; keyRe.lastIndex = 0;
  while ((k = keyRe.exec(lines[i]))) {
    const key = k[1] || k[2], o = owner[key];
    if (!o || o === reader || MODULES[o].core) continue;   // core modules (Today, Settings) are open to all
    const pair = reader + '->' + o;
    counts[pair] = (counts[pair] || 0) + 1;
    (detail[pair] = detail[pair] || []).push(`${i + 1}:${key}`);
  }
}

if (args.has('--report')) {
  Object.keys(counts).sort((a, b) => counts[b] - counts[a]).forEach(p =>
    console.log(p.padEnd(24), String(counts[p]).padStart(4), ' ', detail[p].slice(0, 12).join(' ')));
}
if (args.has('--update')) {
  fs.writeFileSync(BASE_FILE, JSON.stringify({ _about: 'Cross-module STATE reads allowed per reader->owner pair. Only ever goes down. Rewrite with: node scripts/check-modules.mjs --update', counts: Object.fromEntries(Object.entries(counts).sort()) }, null, 2) + '\n');
  console.log('baseline written:', Object.values(counts).reduce((a, b) => a + b, 0), 'cross-module reads');
} else {
  const base = fs.existsSync(BASE_FILE) ? JSON.parse(fs.readFileSync(BASE_FILE, 'utf8')).counts : {};
  Object.keys(counts).forEach(p => {
    const allowed = base[p] || 0;
    if (counts[p] > allowed) problems.push(`${p}: ${counts[p]} direct reads of another module's data (baseline ${allowed}). Read it through VeniaOS.get() instead. New: ${detail[p].slice(-(counts[p] - allowed)).join(' ')}`);
  });
}
if (problems.length) { console.error('Module check failed:\n - ' + problems.join('\n - ')); process.exit(1); }
console.log(`Module check passed: ${ids.length} modules, ${Object.keys(owner).length} keys, ${Object.values(counts).reduce((a, b) => a + b, 0)} cross-module reads within baseline.`);
