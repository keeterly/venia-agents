#!/usr/bin/env node
// Points VENIA OS at a commit of the pattern CAD.
//
// The CAD is built in keeterly/venia-pattern-cad, which is PRIVATE; this
// repository is public. So no CAD code is copied here. VENIA OS serves the
// CAD through netlify/functions/pattern-cad.js, which reads the CAD's own
// build from its repository at the commit pinned below, and only for a
// signed-in Product member. Pinning is the whole sync:
//
//   SOURCE.json                                 which commit is live, for people
//   netlify/functions/_shared/pattern-cad-pin.js the same, for the function
//   dist/index.html, dist/host.js               the frame page (no CAD code)
//
// Usage (from the venia-agents root):
//   git -C ../venia-pattern-cad pull
//   node modules/pattern-cad/scripts/sync.mjs ../venia-pattern-cad
// then commit and bump the build number as usual.
//
// It refuses a checkout whose dist/ has uncommitted changes or whose commit is
// not on GitHub yet, because the function can only fetch what GitHub has.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = path.resolve(here, '..');
const repoRoot = path.resolve(mod, '..', '..');
const cad = path.resolve(process.argv[2] || process.env.PATTERN_CAD_DIR || path.join(repoRoot, '..', 'venia-pattern-cad'));
const REPO = 'keeterly/venia-pattern-cad';
const BASE = '/modules/pattern-cad/dist/';
const fail = (m) => { console.error(m); process.exit(1); };

const srcPage = path.join(cad, 'dist', 'index.html');
if (!fs.existsSync(srcPage)) fail('No CAD build at ' + srcPage + '. Pass the path to a venia-pattern-cad checkout.');
const page = fs.readFileSync(srcPage, 'utf8');
const git = (...a) => { try { return execFileSync('git', ['-C', cad, ...a], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const commit = git('rev-parse', 'HEAD');
if (!commit) fail('Not a git checkout: ' + cad);
if (git('status', '--porcelain', '--', 'dist')) fail('The CAD checkout has uncommitted changes in dist/. Pin only a committed build.');
if (!git('branch', '-r', '--contains', commit)) fail('Commit ' + commit + ' is not on GitHub yet. Push it in the CAD repository first.');
// The function splits the page into one <style> and one <script>; check that holds.
const style = /<style>([\s\S]*?)<\/style>/.exec(page);
const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!style || scripts.length !== 1) fail('The CAD page is not in the shape VENIA OS expects (one <style>, one <script>). Check its build.mjs.');
const fonts = /<link rel="preconnect"[^>]*>\s*<link rel="stylesheet"[^>]*>/.exec(page);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const pin = { repo: REPO, commit, pageSha256: sha(page) };
const info = { ...pin, committedAt: git('log', '-1', '--format=%cI'), subject: git('log', '-1', '--format=%s'), pinnedAt: new Date().toISOString() };
fs.writeFileSync(path.join(mod, 'SOURCE.json'), JSON.stringify(info, null, 2) + '\n');
fs.writeFileSync(path.join(repoRoot, 'netlify', 'functions', '_shared', 'pattern-cad-pin.js'),
  '// Written by modules/pattern-cad/scripts/sync.mjs. The commit of the pattern CAD that VENIA OS serves.\n'
  + 'export const PIN = ' + JSON.stringify(pin, null, 2) + ';\n');

const out = path.join(mod, 'dist');
fs.mkdirSync(out, { recursive: true });
const host = fs.readFileSync(path.join(mod, 'src', 'host.js'), 'utf8');
fs.writeFileSync(path.join(out, 'host.js'), host);
const hv = sha(host).slice(0, 12);
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Dr4ft · VENIA OS</title>
<link rel="icon" href="/icons/icon-192.png">
${fonts ? fonts[0] : ''}
<!-- The CAD itself (keeterly/venia-pattern-cad @ ${commit}) is loaded by host.js
     from /.netlify/functions/pattern-cad for a signed-in Product member. Written by
     modules/pattern-cad/scripts/sync.mjs; do not edit. -->
<style>html,body{margin:0;height:100%;background:#f1efea}@media screen{html,body{overflow:hidden}}#vpc-gate{font:13px/1.6 'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1d1d1b;max-width:420px;margin:18vh auto 0;padding:0 24px;text-align:center}#vpc-gate a{color:inherit}</style>
</head>
<body>
<div id="root"></div>
<script src="${BASE}host.js?v=${hv}" data-v="${commit}"></script>
</body>
</html>
`);
console.log(`pattern CAD pinned to ${commit.slice(0, 12)}: ${info.subject}`);
