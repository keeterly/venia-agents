import webpush from 'web-push';

// Morning push digest — a scheduled function (7:00 AM Pacific) that reaches
// the founders' phones even with the app closed.
//
// How the data gets here WITHOUT a service-role key (same pattern as
// agent-background's write-back): a signed-in founder device publishes the
// Today-focus digest into venia_daily_digest as it recomputes, and flags its
// own push subscription with digest=true when the founder opts in. This
// function calls the venia_digest_fetch RPC (SECURITY DEFINER) with a shared
// secret that lives only in the RLS-sealed venia_config table and in the
// VENIA_DIGEST_SECRET Netlify env var. Wrong or missing secret → nothing.
//
// Fail-boring: if the secret or VAPID keys aren't configured, or the digest
// is stale (no device synced in 36h), it does nothing at all.
const SB_URL = 'https://unxfaeqjskzzmhyrekqx.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueGZhZXFqc2t6em1oeXJla3F4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NDgxMTQsImV4cCI6MjA5MzQyNDExNH0.tqKiJJZE9iz29g9hIscLeMir4PhBMeTU8fbI04eC6xY';

export default async () => {
  const secret = process.env.VENIA_DIGEST_SECRET;
  const vapidPub = process.env.VAPID_PUBLIC_KEY;
  const vapidPriv = process.env.VAPID_PRIVATE_KEY;
  if (!secret || !vapidPub || !vapidPriv) return new Response('digest not configured', { status: 200 });

  let payload = null;
  try {
    const r = await fetch(SB_URL + '/rest/v1/rpc/venia_digest_fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SB_ANON, Authorization: 'Bearer ' + SB_ANON },
      body: JSON.stringify({ p_secret: secret }),
    });
    payload = await r.json();
  } catch (e) { return new Response('fetch failed', { status: 200 }); }
  if (!payload || payload.error) return new Response('unauthorized or empty', { status: 200 });

  const subs = Array.isArray(payload.subs) ? payload.subs.slice(0, 12) : [];
  const at = payload.items && payload.items.at;
  const list = (payload.items && Array.isArray(payload.items.list)) ? payload.items.list : [];
  const urgent = list.filter((i) => i && (i.pri === 'high' || i.pri === 'med'));
  if (!subs.length || !urgent.length) return new Response('nothing to send', { status: 200 });
  // A digest no device has refreshed in 36 hours is yesterday's news — a
  // stale push is worse than none.
  if (!at || (Date.now() - new Date(at).getTime()) > 36 * 3600 * 1000) {
    return new Response('digest stale — skipped', { status: 200 });
  }

  webpush.setVapidDetails('mailto:keeter@veniacollection.com', vapidPub, vapidPriv);
  const n = urgent.length;
  const note = JSON.stringify({
    title: n + ' thing' + (n > 1 ? 's' : '') + ' need' + (n > 1 ? '' : 's') + ' you today',
    body: urgent.slice(0, 3).map((i) => '• ' + String(i.text || '').slice(0, 120)).join('\n'),
    tag: 'venia-digest',
  });
  await Promise.allSettled(subs.map((s) => webpush.sendNotification(s, note)));
  return new Response('sent to ' + subs.length + ' device(s)', { status: 200 });
};

// 14:00 UTC = 7:00 AM Pacific (adjust the cron here if the mornings move).
export const config = { schedule: '0 14 * * *' };
