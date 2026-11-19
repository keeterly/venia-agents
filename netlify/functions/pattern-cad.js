// Pattern CAD (Build 634): hands the CAD's code to a signed-in Product member,
// and to nobody else.
//
// The CAD is built in keeterly/venia-pattern-cad, which is PRIVATE, and this
// repository is public, so none of the CAD's code lives here. This function
// reads the CAD's own build (dist/index.html) from that repository at the
// commit pinned in _shared/pattern-cad-pin.js, splits it into its styles and
// its script, and serves the part asked for — only to someone whose Supabase
// session says they can read Product in VENIA and Pattern CAD is switched on.
//
// Needs two environment variables on the Netlify site:
//   PATTERN_CAD_GITHUB_TOKEN  a fine-grained GitHub token, read-only "Contents"
//                             on keeterly/venia-pattern-cad and nothing else
//   SUPABASE_ANON_KEY         already set for the VENIA OS connector
//
// GET /.netlify/functions/pattern-cad?part=app.js|app.css|page&v=<commit>
//   Authorization: Bearer <the person's Supabase access token>
import { createHash } from 'crypto';
import { getStore } from '@netlify/blobs';
import { PIN } from './_shared/pattern-cad-pin.js';
import { SB_URL, anonKey } from './mcp/supa.js';
import { VENIA_ORIGINS } from './_shared/origins.js';

const memo = new Map();   // commit -> { css, js, page }, for a warm function

function split(page) {
  const style = /<style>([\s\S]*?)<\/style>/.exec(page);
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (!style || scripts.length !== 1) throw new Error('unexpected CAD build shape');
  return { css: style[1], js: scripts[0][1], page };
}

async function cadBuild(commit) {
  if (memo.has(commit)) return memo.get(commit);
  let page = null, blobs = null;
  try { blobs = getStore({ name: 'pattern-cad' }); page = await blobs.get(commit + '/index.html', { type: 'text' }); } catch (_) { page = null; }
  if (!page) {
    const token = process.env.PATTERN_CAD_GITHUB_TOKEN;
    if (!token) { const e = new Error('not configured'); e.status = 503; throw e; }
    const r = await fetch(`https://api.github.com/repos/${PIN.repo}/contents/dist/index.html?ref=${encodeURIComponent(commit)}`, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github.raw+json', 'User-Agent': 'venia-os', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!r.ok) { const e = new Error('GitHub answered ' + r.status); e.status = r.status === 401 || r.status === 403 || r.status === 404 ? 503 : 502; throw e; }
    page = await r.text();
  }
  // The pin carries the page's hash, so only the exact build that was pinned is served.
  if (PIN.pageSha256 && createHash('sha256').update(page).digest('hex') !== PIN.pageSha256) {
    const e = new Error('CAD build does not match its pin'); e.status = 502; throw e;
  }
  const built = split(page);
  memo.set(commit, built);
  try { if (blobs) await blobs.set(commit + '/index.html', page); } catch (_) {}
  return built;
}

async function rpc(name, token, body) {
  const r = await fetch(SB_URL + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: { apikey: anonKey(), Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) return null;
  try { return await r.json(); } catch (_) { return null; }
}

// Product readable in VENIA (founders always), and Pattern CAD not switched off.
async function mayOpen(token) {
  if (!token || !anonKey()) return false;
  const [canProduct, entitled] = await Promise.all([
    rpc('venia_can', token, { t: 'main', m: 'product', action: 'read' }),
    rpc('venia_entitled', token, { t: 'main', m: 'pattern-cad' }),
  ]);
  return canProduct === true && entitled !== false;
}

const TYPES = { 'app.js': 'text/javascript; charset=utf-8', 'app.css': 'text/css; charset=utf-8', page: 'text/html; charset=utf-8' };

export default async (req) => {
  const origin = req.headers.get('origin');
  if (origin && !VENIA_ORIGINS.has(origin)) return new Response('Forbidden', { status: 403 });
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const url = new URL(req.url);
  const part = url.searchParams.get('part');
  if (!TYPES[part]) return Response.json({ error: 'unknown part' }, { status: 400 });
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return Response.json({ error: 'sign in' }, { status: 401 });
  let ok = false;
  try { ok = await mayOpen(token); } catch (_) { ok = false; }
  if (!ok) return Response.json({ error: 'not open to you' }, { status: 403 });
  try {
    const b = await cadBuild(PIN.commit);
    const body = part === 'app.js' ? b.js : part === 'app.css' ? b.css : b.page;
    return new Response(body, { status: 200, headers: {
      'Content-Type': TYPES[part],
      // Keyed by commit in the URL, and only ever for this person's browser.
      'Cache-Control': url.searchParams.get('v') === PIN.commit ? 'private, max-age=86400' : 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    } });
  } catch (e) {
    const status = e.status || 502;
    return Response.json({ error: status === 503 ? 'not configured' : 'could not load the CAD' }, { status });
  }
};
