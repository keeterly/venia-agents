// Who may call VENIA's functions from a browser.
//
// The live addresses, plus this one Netlify site's own preview and branch
// deploys — deploy-preview-256--venia-creator.netlify.app, a branch alias, or a
// deploy permalink. Those were refused with 403 before, so a pull request could
// never be checked against live Shopify or Claude before it was merged.
//
// ONLY THIS SITE. The host has to END in "--venia-creator.netlify.app" and the
// label before it may hold single hyphens only. Netlify reads "x--y.netlify.app"
// as deploy alias x of site y, so a host of that shape is always served by the
// venia-creator site and nobody else's. Any other *.netlify.app is refused.
//
// The origin check is the first door, not the wall: every function that
// touches data still requires the VENIA access code (or a signed-in founder),
// on a preview exactly as on the live site.
const LIVE = new Set([
  'https://creator.veniacollection.com',
  'https://venia-creator.netlify.app',
  'https://main--venia-creator.netlify.app',
]);
const PREVIEW = /^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*--venia-creator\.netlify\.app$/;

export function isVeniaOrigin(origin) {
  if (!origin || typeof origin !== 'string') return false;
  return LIVE.has(origin) || PREVIEW.test(origin);
}

// Drop-in for the old `new Set([...])` so every call site reads the same.
export const VENIA_ORIGINS = { has: isVeniaOrigin };
