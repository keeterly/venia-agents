// Instagram keepalive (Build 701) — a scheduled function that renews the
// Instagram token every day, whether or not anyone opens Social.
//
// Why: Instagram's long-lived token lasts 60 days and can only be renewed
// while it is still alive. Until now the only renewal ran when someone opened
// Social in the token's last ten days. Nobody did in late October, so the
// connection lapsed on Oct 31 and could only come back by reconnecting.
//
// How, without a new secret: it calls the `instagram` Supabase function with
// the shared secret that already guards the morning digest (VENIA_DIGEST_SECRET
// here, venia_config.digest_secret there). The function renews the token once
// it is ten days old and answers with dates only — the token never leaves it.
//
// Fail-boring: no secret configured, or nothing connected, and it does nothing.
const SB_URL = 'https://unxfaeqjskzzmhyrekqx.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueGZhZXFqc2t6em1oeXJla3F4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NDgxMTQsImV4cCI6MjA5MzQyNDExNH0.tqKiJJZE9iz29g9hIscLeMir4PhBMeTU8fbI04eC6xY';

export default async () => {
  const secret = process.env.VENIA_DIGEST_SECRET;
  if (!secret) return new Response('keepalive not configured', { status: 200 });
  try {
    const r = await fetch(SB_URL + '/functions/v1/instagram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SB_ANON, Authorization: 'Bearer ' + SB_ANON },
      body: JSON.stringify({ action: 'keepalive', secret }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return new Response('keepalive refused: ' + String(j.error || r.status), { status: 200 });
    if (!j.connected) return new Response('nothing connected', { status: 200 });
    return new Response((j.renewed ? 'renewed' : 'still fresh') + ' · ' + j.daysLeft + ' days left'
      + (j.lastError ? ' · ' + String(j.lastError).slice(0, 120) : ''), { status: 200 });
  } catch (e) {
    return new Response('keepalive failed: ' + String(e && e.message || e), { status: 200 });
  }
};

// 12:30 UTC daily = 4:30 / 5:30 AM Pacific, before anyone opens the app.
export const config = { schedule: '30 12 * * *' };
