import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Instagram — READ ONLY. The live feed, and nothing else.
//
// WHAT THIS DOES: connects one Instagram professional account, keeps its token
// alive, and hands the app back the media that account has already published,
// so Social Command's grid can show the real feed below its published boundary
// instead of an approximation migrated out of the old calendar.
//
// WHAT IT DELIBERATELY CANNOT DO: publish, schedule, delete, comment, or reply.
// The scope requested is `instagram_business_basic` alone. Publishing needs
// `instagram_business_content_publish`, which is not requested here and would
// not be granted by a token minted here — so a bug in the browser cannot post
// to the account, because the credential itself has no such power.
//
// WHERE THE TOKEN LIVES: venia_instagram, a table with RLS on and no policies,
// reachable only by the service role inside this function. It is never
// returned to the browser under any action, including status.
//
// Actions (POST JSON, founder JWT required):
//   {action:'status'}      -> connected?, username, when the token expires
//   {action:'authurl'}     -> the URL to send the founder to, with fresh state
//   {action:'feed', limit} -> published media, refreshing the token if needed
//   {action:'disconnect'}  -> forget the account and the token
//
// The OAuth redirect itself lands on the sibling function `instagram-callback`,
// which is public because Instagram redirects a browser there with no headers.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

// Matches venia_is_founder() in the database, and the list in the team
// function. An Instagram account is the brand's public voice; connecting or
// disconnecting it is not something a module grant should carry.
const FOUNDERS = ["keeter@veniacollection.com", "christine@veniacollection.com"];

// READ ONLY, and stated in one place so it cannot drift. Adding a scope here is
// the deliberate act that would make publishing possible; nothing else in this
// file assumes it.
const SCOPES = "instagram_business_basic";

// Meta issues 60 days and allows a refresh while the token is still valid. A
// token refreshed with a week to spare survives a fortnight of nobody opening
// the app; one refreshed on the last day does not survive a long weekend.
const REFRESH_WHEN_DAYS_LEFT = 10;

const IG_AUTH = "https://www.instagram.com/oauth/authorize";
const IG_TOKEN = "https://api.instagram.com/oauth/access_token";
const IG_GRAPH = "https://graph.instagram.com";

function admin() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

// The connection as the app is allowed to see it: everything except the one
// field that matters. There is no action that returns access_token, so there is
// no bug in the client that could leak it.
function publicRow(r: Record<string, unknown> | null) {
  if (!r) return { connected: false };
  const exp = r.expires_at ? new Date(String(r.expires_at)) : null;
  const daysLeft = exp ? Math.floor((exp.getTime() - Date.now()) / 86400000) : null;
  return {
    connected: true,
    username: r.username || "",
    igUserId: r.ig_user_id || "",
    accountType: r.account_type || "",
    expiresAt: r.expires_at || null,
    daysLeft: daysLeft,
    // Said plainly rather than left for the screen to work out: a token past
    // its date is not "an error", it is a reconnection the founder has to make.
    expired: daysLeft !== null && daysLeft < 0,
    connectedAt: r.connected_at || null,
    connectedBy: r.connected_by || "",
    lastSyncAt: r.last_sync_at || null,
    lastError: r.last_error || "",
  };
}

// Keep the token alive. Returns the token to use, or throws with the reason
// Instagram gave — which is the difference between "reconnect the account" and
// "the network was down".
async function liveToken(db: ReturnType<typeof admin>, row: Record<string, unknown>) {
  const token = String(row.access_token || "");
  const exp = row.expires_at ? new Date(String(row.expires_at)) : null;
  const daysLeft = exp ? (exp.getTime() - Date.now()) / 86400000 : 999;
  if (daysLeft < 0) throw new Error("The Instagram connection has expired — reconnect the account.");
  if (daysLeft > REFRESH_WHEN_DAYS_LEFT) return token;

  const u = new URL(IG_GRAPH + "/refresh_access_token");
  u.searchParams.set("grant_type", "ig_refresh_token");
  u.searchParams.set("access_token", token);
  const r = await fetch(u.toString());
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    // A failed refresh is NOT a reason to drop the token: the old one is still
    // valid until its date, and throwing it away would turn a bad minute into a
    // reconnection. Record why and carry on with what we have.
    await db.from("venia_instagram").update({
      last_error: String(j?.error?.message || "refresh failed"), updated_at: new Date().toISOString(),
    }).eq("id", "venia");
    return token;
  }
  const expiresAt = new Date(Date.now() + (Number(j.expires_in) || 5184000) * 1000).toISOString();
  await db.from("venia_instagram").update({
    access_token: j.access_token, expires_at: expiresAt, last_error: "",
    updated_at: new Date().toISOString(),
  }).eq("id", "venia");
  return String(j.access_token);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const b = await req.json().catch(() => ({}));
    const action = String(b.action || "status");
    const db = admin();

    let founder = "";
    try {
      const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (jwt) {
        const { data } = await db.auth.getUser(jwt);
        const em = String(data?.user?.email || "").toLowerCase();
        if (FOUNDERS.includes(em)) founder = em;
      }
    } catch (_) { /* not signed in */ }
    if (!founder) return json({ error: "founders only" }, 403);

    const { data: row } = await db.from("venia_instagram")
      .select("*").eq("id", "venia").maybeSingle();

    if (action === "status") return json(publicRow(row));

    if (action === "disconnect") {
      await db.from("venia_instagram").delete().eq("id", "venia");
      // The token is gone from here, but it is still valid at Meta until it
      // expires. Say so — "disconnected" that quietly leaves a live credential
      // in someone else's system is not the truth.
      return json({
        connected: false,
        note: "Removed here. The token stays valid at Meta until it expires — "
            + "revoke the app under Instagram → Settings → Apps and websites to end it now.",
      });
    }

    const appId = Deno.env.get("INSTAGRAM_APP_ID") || "";
    const redirect = Deno.env.get("INSTAGRAM_REDIRECT_URI") || "";

    if (action === "authurl") {
      if (!appId || !redirect || !Deno.env.get("INSTAGRAM_APP_SECRET")) {
        return json({
          error: "not configured",
          // Names the missing pieces so the screen can say what to do rather
          // than "something went wrong".
          missing: [
            appId ? null : "INSTAGRAM_APP_ID",
            Deno.env.get("INSTAGRAM_APP_SECRET") ? null : "INSTAGRAM_APP_SECRET",
            redirect ? null : "INSTAGRAM_REDIRECT_URI",
          ].filter(Boolean),
        }, 400);
      }
      // Fresh state per attempt, and the old ones swept as we go so an
      // abandoned authorization does not accumulate.
      await db.from("venia_instagram_oauth")
        .delete().lt("created_at", new Date(Date.now() - 600_000).toISOString());
      const state = crypto.randomUUID().replace(/-/g, "");
      await db.from("venia_instagram_oauth").insert({ state, created_by: founder });
      const u = new URL(IG_AUTH);
      u.searchParams.set("client_id", appId);
      u.searchParams.set("redirect_uri", redirect);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", SCOPES);
      u.searchParams.set("state", state);
      return json({ url: u.toString(), scopes: SCOPES });
    }

    if (action === "feed") {
      if (!row) return json({ connected: false, items: [] });
      let token: string;
      try { token = await liveToken(db, row); }
      catch (e) { return json({ connected: true, expired: true, items: [], error: String((e as Error).message) }); }

      const limit = Math.max(1, Math.min(Number(b.limit) || 24, 50));
      const fields = [
        "id", "caption", "media_type", "media_product_type", "media_url", "permalink",
        "thumbnail_url", "timestamp", "like_count", "comments_count", "is_shared_to_feed",
      ].join(",");
      const u = new URL(IG_GRAPH + "/me/media");
      u.searchParams.set("fields", fields);
      u.searchParams.set("limit", String(limit));
      u.searchParams.set("access_token", token);
      const r = await fetch(u.toString());
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = String(j?.error?.message || "Instagram refused the request");
        await db.from("venia_instagram").update({ last_error: msg, updated_at: new Date().toISOString() })
          .eq("id", "venia");
        return json({ connected: true, items: [], error: msg }, 200);
      }
      await db.from("venia_instagram").update({
        last_sync_at: new Date().toISOString(), last_error: "", updated_at: new Date().toISOString(),
      }).eq("id", "venia");

      // Normalised to what the grid actually draws. mediaUrl is a Meta CDN URL
      // that EXPIRES and must never be stored as a permanent asset — the app
      // keeps the id and the permalink and asks for the picture again. That is
      // why this function exists rather than a one-off import.
      const items = (j.data || []).map((m: Record<string, unknown>) => ({
        id: String(m.id),
        caption: String(m.caption || ""),
        kind: m.media_type === "VIDEO"
          ? (m.media_product_type === "REELS" ? "reel" : "video")
          : m.media_type === "CAROUSEL_ALBUM" ? "carousel" : "single",
        surface: String(m.media_product_type || "FEED"),
        mediaUrl: String(m.thumbnail_url || m.media_url || ""),
        permalink: String(m.permalink || ""),
        at: String(m.timestamp || ""),
        likes: m.like_count ?? null,
        comments: m.comments_count ?? null,
      }));
      return json({
        connected: true, items,
        fetchedAt: new Date().toISOString(),
        // The picture links die; say when, so nothing downstream treats them as
        // storable. One hour is conservative — Meta does not publish the TTL.
        mediaUrlsExpire: true,
        username: row.username || "",
      });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
