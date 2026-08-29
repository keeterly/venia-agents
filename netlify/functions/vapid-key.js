// THE APP SHOULD NOT CARRY ITS OWN COPY OF THE PUBLIC KEY.
// It used to hardcode one, which had to be kept in step by hand with the pair
// in Netlify. Nothing enforced that, and the two drifting apart is invisible:
// the push service just answers 403. Worse, it made fixing the missing private
// key a two-sided change — paste a new pair, then edit and redeploy the app.
// Serving the public half here makes Netlify the single source of truth, so
// any valid pair set there works with no code change at all.
// A VAPID public key is public by construction; there is nothing to gate.
const ALLOWED_ORIGINS = new Set([
  'https://creator.veniacollection.com',
  'https://venia-creator.netlify.app',
  'https://main--venia-creator.netlify.app',
]);
export default async (req) => {
  const o = req.headers.get('origin');
  const site = (req.headers.get('sec-fetch-site') || '').toLowerCase();
  if (o ? !ALLOWED_ORIGINS.has(o) : !(site === 'same-origin' || site === 'same-site' || site === 'none' || !site)) {
    return new Response('', { status: 403 });
  }
  const key = process.env.VAPID_PUBLIC_KEY || '';
  const paired = !!(key && process.env.VAPID_PRIVATE_KEY);
  return new Response(JSON.stringify({ key, paired }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
};
