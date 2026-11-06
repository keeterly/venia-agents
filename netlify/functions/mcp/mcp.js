// VENIA OS connector — the endpoint Claude talks to.
//
// One Netlify function answers every path the connector needs:
//
//   /mcp                                      the MCP server (Streamable HTTP, JSON replies)
//   /.well-known/oauth-protected-resource     where to sign in (RFC 9728)
//   /.well-known/oauth-authorization-server   how to sign in (RFC 8414)
//   /oauth/register                           Claude registers itself (RFC 7591)
//   /oauth/authorize                          the VENIA sign-in page
//   /oauth/token                              codes and refresh tokens → access tokens
//
// Add it in Claude: Settings → Connectors → Add custom connector, with the URL
// https://creator.veniacollection.com/mcp. See the pull request that added this
// file for the environment variables it needs.
//
// STATELESS ON PURPOSE. Every POST carries its own bearer token, every reply is
// a single JSON body, and there is no server-to-client stream (GET /mcp is 405,
// which the spec allows). Nothing has to survive between invocations except
// the sign-ins in Netlify Blobs.
import * as oauth from './oauth.js';
import { listTools, callTool } from './tools.js';
import { encryptionConfigured } from './store.js';
import { anonKey } from './supa.js';
import { isVeniaOrigin } from '../_shared/origins.js';

const SERVER_INFO = { name: 'venia-os', title: 'VENIA OS', version: '1.0.0' };
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'VENIA OS is VENIA Collection\'s internal operating app: Today, Product (styles, '
  + 'materials, vendors), Growth (press pulls, coverage), Sales (wholesale buyers, quotes, orders) and Money. '
  + 'Read tools return what the signed-in person can see. Every write tool only PROPOSES a change: it waits in '
  + 'VENIA OS under "From Claude" until a person approves it there, so tell the person it is waiting, never that '
  + 'it is done. Use list_proposals to see what was approved.';

// Browsers may only reach /mcp from these origins. Claude's servers send no
// Origin at all, so this blocks nothing real and stops a web page from driving
// the endpoint with a stolen token (the spec's DNS-rebinding guard).
// VENIA's own addresses come from the shared list, which also lets this site's
// preview deploys through (exact site only) so a PR can be checked end to end.
const CLAUDE_ORIGINS = new Set(['https://claude.ai', 'https://claude.com']);
const ALLOWED_ORIGINS = { has: (o) => CLAUDE_ORIGINS.has(o) || isVeniaOrigin(o) };

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'WWW-Authenticate',
};
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
const reply = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

async function handleRpc(msg, ctx) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg && msg.id, -32600, 'Invalid request');
  const isNotification = msg.id === undefined || msg.id === null;
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize': {
      const asked = p.protocolVersion;
      return rpcResult(msg.id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return isNotification ? null : rpcResult(msg.id, {});
    case 'tools/list': return rpcResult(msg.id, { tools: listTools() });
    case 'tools/call': {
      if (!p.name) return rpcError(msg.id, -32602, 'Missing tool name');
      return rpcResult(msg.id, await callTool(String(p.name), p.arguments, ctx));
    }
    case 'resources/list': return rpcResult(msg.id, { resources: [] });
    case 'prompts/list': return rpcResult(msg.id, { prompts: [] });
    default:
      if (msg.method.startsWith('notifications/')) return null;
      return isNotification ? null : rpcError(msg.id, -32601, 'Method not found: ' + msg.method);
  }
}

async function handleMcp(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return new Response('', { status: 405, headers: { ...cors, Allow: 'POST' } });
  const o = req.headers.get('origin');
  if (o && !ALLOWED_ORIGINS.has(o)) return reply(rpcError(null, -32000, 'Origin not allowed'), 403);

  const who = await oauth.resolveBearer(req);
  if (!who) return oauth.unauthorized(req);

  let body;
  try { body = await req.json(); } catch (_) { return reply(rpcError(null, -32700, 'Parse error'), 400); }
  const ctx = { email: who.email, access: who.access };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleRpc(m, ctx)))).filter(Boolean);
    return out.length ? reply(out) : new Response(null, { status: 202, headers: cors });
  }
  const out = await handleRpc(body, ctx);
  return out ? reply(out) : new Response(null, { status: 202, headers: cors });
}

export default async (req) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS' && path !== '/mcp') return new Response(null, { status: 204, headers: cors });

  // Not set up yet: say so plainly rather than half-working.
  if (!encryptionConfigured() || !anonKey()) {
    return new Response(JSON.stringify({
      error: 'not_configured',
      error_description: 'The VENIA OS connector needs MCP_ENCRYPTION_KEY and SUPABASE_ANON_KEY set on this Netlify site.',
    }), { status: 503, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  try {
    if (path === '/mcp') return await handleMcp(req);
    if (path.startsWith('/.well-known/oauth-protected-resource')) return oauth.protectedResourceMetadata(req);
    if (path.startsWith('/.well-known/oauth-authorization-server')) return oauth.authServerMetadata(req);
    if (path === '/oauth/register' && req.method === 'POST') return await oauth.register(req);
    if (path === '/oauth/authorize' && req.method === 'GET') return await oauth.authorizeGet(req);
    if (path === '/oauth/authorize' && req.method === 'POST') return await oauth.authorizePost(req);
    if (path === '/oauth/token' && req.method === 'POST') return await oauth.token(req);
    return new Response('Not found', { status: 404 });
  } catch (e) {
    console.error('[mcp]', e && e.stack || e);
    return new Response(JSON.stringify({ error: 'server_error' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
};

export const config = {
  path: [
    '/mcp',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/mcp',
    '/oauth/register',
    '/oauth/authorize',
    '/oauth/token',
  ],
};
