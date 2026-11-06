// VENIA OS connector — storage and crypto for the Claude sign-in.
//
// WHY NETLIFY BLOBS AND NOT A TABLE. The connector holds one thing per
// sign-in: the founder's Supabase session, so every tool call can run AS them.
// Writing that to Postgres would need either the service-role key (which this
// app has never had on the server, on purpose) or a SECURITY DEFINER door that
// anyone holding the anon key could knock on. Netlify Blobs is private to this
// site's functions and needs no key at all.
//
// WHY ENCRYPTED ANYWAY. A Supabase refresh token is a working login. Blobs is
// private, but "private" is one setting away from not being, and a store dump
// should be useless on its own. Every session is sealed with AES-256-GCM under
// MCP_ENCRYPTION_KEY, which lives only in Netlify's environment variables.
//
// WHY ONLY HASHES AS KEYS. The tokens Claude holds are random strings; the
// store is keyed by their SHA-256. Reading the store never yields a token that
// could be replayed against /mcp.
import { getStore } from '@netlify/blobs';
import { webcrypto as crypto } from 'node:crypto';

const STORE_NAME = 'venia-mcp';
let _store = null;
let _memory = null;            // test hook: an in-memory stand-in for Blobs

export function useMemoryStore() {
  const m = new Map();
  _memory = {
    async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async setJSON(k, v) { m.set(k, JSON.stringify(v)); },
    async delete(k) { m.delete(k); },
    _map: m,
  };
  return _memory;
}

function store() {
  if (_memory) return _memory;
  if (!_store) {
    const s = getStore({ name: STORE_NAME, consistency: 'strong' });
    _store = {
      async get(k) { return s.get(k, { type: 'json' }); },
      async setJSON(k, v) { return s.setJSON(k, v); },
      async delete(k) { return s.delete(k); },
    };
  }
  return _store;
}

export async function getJSON(key) {
  const v = await store().get(key);
  if (!v) return null;
  // Every record carries its own expiry; Blobs has no TTL, so an expired
  // record is deleted the first time anyone reads it.
  if (v.exp && v.exp < Date.now()) { await store().delete(key).catch(() => {}); return null; }
  return v;
}
export async function putJSON(key, value) { await store().setJSON(key, value); }
export async function del(key) { await store().delete(key).catch(() => {}); }

// ── random tokens and their hashes ──────────────────────────────────────────
export function randomToken(bytes = 32) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Buffer.from(b).toString('base64url');
}
export async function sha256b64url(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Buffer.from(new Uint8Array(d)).toString('base64url');
}

// ── sealing the Supabase session ────────────────────────────────────────────
let _key = null;
export function encryptionConfigured() {
  const raw = process.env.MCP_ENCRYPTION_KEY || '';
  try { return Buffer.from(raw, 'base64').length === 32; } catch (_) { return false; }
}
async function aesKey() {
  if (_key) return _key;
  const raw = Buffer.from(process.env.MCP_ENCRYPTION_KEY || '', 'base64');
  if (raw.length !== 32) throw new Error('MCP_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  _key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return _key;
}
export async function seal(obj) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(),
    new TextEncoder().encode(JSON.stringify(obj)));
  return Buffer.from(iv).toString('base64url') + '.' + Buffer.from(new Uint8Array(ct)).toString('base64url');
}
export async function unseal(text) {
  const [ivB, ctB] = String(text || '').split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(ivB, 'base64url') },
    await aesKey(), Buffer.from(ctB, 'base64url'));
  return JSON.parse(new TextDecoder().decode(pt));
}
export function _resetKeyForTests() { _key = null; }
