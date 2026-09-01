import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// The one public door in the Instagram connector — because Instagram redirects
// a browser here with no headers of ours on it, so nothing can be required.
//
// It is safe to be public because it can do exactly one thing: redeem an
// authorization code that arrives with a state value THIS APP minted minutes
// ago and has not yet used. Without a matching unused state it does nothing at
// all — no token exchange, no write, no different answer that would tell an
// attacker they were close.
//
// SUPABASE WILL NOT SERVE HTML FROM AN EDGE FUNCTION.
// It rewrites text/html to text/plain on the default *.supabase.co domain, an
// anti-phishing measure, and sends nosniff with it — so a browser shows the
// source of the page instead of the page. Confirmed against the deployment:
// the JSON branch keeps its content type and only the HTML one is rewritten.
//
// So do not render. Send the founder back into VENIA OS with the outcome in the
// query string, which is where they wanted to end up anyway. A bare page with a
// Close button was always the worse half of this.
const APP_URL = Deno.env.get("VENIA_APP_URL") || "https://creator.veniacollection.com";

// The whole result of this function, expressed as somewhere to be. `ok` carries
// the account that connected; `err` carries the reason, short enough to read.
function backToApp(good: boolean, detail: string) {
  const u = new URL(APP_URL);
  u.searchParams.set("ig", good ? "ok" : "err");
  if (detail) u.searchParams.set("igmsg", detail.slice(0, 160));
  return new Response(null, { status: 302, headers: { Location: u.toString() } });
}
// For the one endpoint a stranger from Meta might open rather than a founder.
// Plain text on purpose: it is a compliance answer, not a screen.
function plain(body: string, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

// ── THE TWO CALLBACKS META INSISTS ON ────────────────────────────────────
// Business login settings also asks for a Deauthorize callback and a Data
// deletion request URL. Pointing them at a page that shrugs would be a lie in a
// form field, so they land here too — distinguished by ?event= — and do the
// real thing: when someone revokes this app inside Instagram, the token we hold
// is already dead, and an app that keeps saying "connected" about a dead token
// is worse than one that says nothing.
//
// Meta signs these with the app secret. Verified, because an unverified
// endpoint that deletes the connection is a URL anyone can use to disconnect us.
async function signedRequestOk(signed: string, secret: string) {
  const [sig, payload] = String(signed).split(".");
  if (!sig || !payload) return null;
  const b64url = (t: string) => {
    const p = t.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(p + "=".repeat((4 - p.length % 4) % 4)), (c) => c.charCodeAt(0));
  };
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const okSig = await crypto.subtle.verify("HMAC", key, b64url(sig), new TextEncoder().encode(payload));
  if (!okSig) return null;
  try { return JSON.parse(new TextDecoder().decode(b64url(payload))); } catch { return null; }
}
async function forgetConnection() {
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  await db.from("venia_instagram").delete().eq("id", "venia");
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  // Meta's dashboard rejects some URLs with a query string in the deauthorize
  // and data-deletion fields, so the same two events are reachable as a path
  // suffix as well: .../instagram-callback/deauthorize. Both spellings, one
  // handler — whichever the form will accept on the day.
  const tail = url.pathname.split("/").filter(Boolean).pop() || "";
  const event = url.searchParams.get("event")
    || (["deauthorize", "delete", "deleted"].includes(tail) ? tail : "");

  if (event === "deauthorize" || event === "delete") {
    const secret = Deno.env.get("INSTAGRAM_APP_SECRET") || "";
    let signed = "";
    try {
      const form = await req.formData();
      signed = String(form.get("signed_request") || "");
    } catch (_) { /* not a form post */ }
    const claim = secret && signed ? await signedRequestOk(signed, secret) : null;
    // Unsigned, or signed by someone who is not Meta: nothing happens, and the
    // answer is the same either way.
    if (!claim) return new Response(JSON.stringify({ error: "unverified" }), {
      status: 400, headers: { "Content-Type": "application/json" } });
    await forgetConnection();
    if (event === "deauthorize") return new Response("ok", { status: 200 });
    // Meta's data-deletion contract: a URL a person can visit to see the status,
    // and a code to quote. There is nothing else of theirs to delete — this app
    // stores one token for one account and no personal data at all.
    return new Response(JSON.stringify({
      url: url.origin + url.pathname + "?event=deleted",
      confirmation_code: "venia-" + String(claim.user_id || "ig"),
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (event === "deleted") {
    return plain("Deleted. The Instagram connection and its token have been removed. "
      + "This application stores no other Instagram data.");
  }

  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const denied = url.searchParams.get("error") || "";

  if (denied) return backToApp(false, "Instagram was not given permission, so nothing was connected.");
  if (!code || !/^[a-f0-9]{16,64}$/.test(state))
    return backToApp(false, "That link is missing something Instagram should have sent.");

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // ONE USE. Deleting on the way in means a code cannot be replayed even if the
  // exchange below fails — the founder starts again, which is cheap, rather
  // than a stale state staying redeemable, which is not.
  const { data: st } = await db.from("venia_instagram_oauth")
    .delete().eq("state", state).select("state, created_by, created_at").maybeSingle();
  if (!st) return backToApp(false, "That authorization was not one this app started, or it was already used.");
  if (Date.now() - new Date(String(st.created_at)).getTime() > 600_000)
    return backToApp(false, "That authorization took too long. Start again.");

  const appId = Deno.env.get("INSTAGRAM_APP_ID") || "";
  const secret = Deno.env.get("INSTAGRAM_APP_SECRET") || "";
  const redirect = Deno.env.get("INSTAGRAM_REDIRECT_URI") || "";
  if (!appId || !secret || !redirect)
    return backToApp(false, "This server has no Instagram app configured yet.");

  try {
    // 1. Code -> short-lived token (one hour).
    const form = new FormData();
    form.set("client_id", appId);
    form.set("client_secret", secret);
    form.set("grant_type", "authorization_code");
    form.set("redirect_uri", redirect);
    form.set("code", code);
    const r1 = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form });
    const j1 = await r1.json().catch(() => ({}));
    if (!r1.ok || !j1.access_token) {
      return backToApp(false, String(j1?.error_message || j1?.error?.message
        || "Instagram would not issue a token."));
    }

    // 2. Short-lived -> long-lived (60 days, refreshable).
    const u2 = new URL("https://graph.instagram.com/access_token");
    u2.searchParams.set("grant_type", "ig_exchange_token");
    u2.searchParams.set("client_secret", secret);
    u2.searchParams.set("access_token", String(j1.access_token));
    const r2 = await fetch(u2.toString());
    const j2 = await r2.json().catch(() => ({}));
    const token = String(j2.access_token || j1.access_token);
    const ttl = Number(j2.expires_in) || 3600;

    // 3. Who did we just connect? Stored so the screen can name the account
    //    rather than saying "connected" about something unidentified.
    const u3 = new URL("https://graph.instagram.com/me");
    u3.searchParams.set("fields", "id,username,account_type");
    u3.searchParams.set("access_token", token);
    const j3 = await (await fetch(u3.toString())).json().catch(() => ({}));

    await db.from("venia_instagram").upsert({
      id: "venia",
      ig_user_id: String(j3.id || j1.user_id || ""),
      username: String(j3.username || ""),
      account_type: String(j3.account_type || ""),
      access_token: token,
      expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
      connected_at: new Date().toISOString(),
      connected_by: String(st.created_by || ""),
      last_error: "",
      updated_at: new Date().toISOString(),
    });

    return backToApp(true, String(j3.username || ""));
  } catch (e) {
    return backToApp(false, String((e as Error).message || e));
  }
});
