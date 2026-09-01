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
// It returns a small HTML page rather than JSON: a human's browser lands here.

const OK_HTML = (title: string, body: string, good: boolean) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
  :root{color-scheme:light}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#fff;color:#111;font:14px/1.7 'Helvetica Neue',Helvetica,Arial,sans-serif;padding:28px}
  .box{max-width:420px;text-align:center}
  h1{font-size:13px;letter-spacing:2.5px;text-transform:uppercase;font-weight:700;margin:0 0 14px;
     color:${good ? "#111" : "#b3352f"}}
  p{color:#666;margin:0 0 18px}
  button{background:#111;color:#fff;border:none;padding:12px 22px;font:inherit;font-size:11px;
    letter-spacing:2px;text-transform:uppercase;font-weight:700;cursor:pointer;min-height:44px}
</style></head><body><div class="box">
  <h1>${title}</h1><p>${body}</p>
  <button onclick="try{window.close()}catch(e){};location.href='/'">Close</button>
</div>
<script>try{ if (window.opener) { window.opener.postMessage({venia:'instagram',ok:${good}}, '*'); } }catch(e){}</script>
</body></html>`;

function page(title: string, body: string, good: boolean, status = 200) {
  return new Response(OK_HTML(title, body, good), {
    status, headers: { "Content-Type": "text/html; charset=utf-8" },
  });
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
  const event = url.searchParams.get("event") || "";

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
    return page("Deleted",
      "The Instagram connection and its token have been removed. This app stores no other Instagram data.", true);
  }

  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const denied = url.searchParams.get("error") || "";

  if (denied) {
    return page("Not connected",
      "Instagram was not given permission, so nothing was connected. You can try again from Social Command.", false);
  }
  if (!code || !/^[a-f0-9]{16,64}$/.test(state)) {
    return page("Not connected", "That link is missing something Instagram should have sent.", false, 400);
  }

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
  if (!st) {
    return page("Not connected",
      "That authorization was not one this app started, or it was already used.", false, 400);
  }
  if (Date.now() - new Date(String(st.created_at)).getTime() > 600_000) {
    return page("Not connected", "That authorization took too long. Start again from Social Command.", false, 400);
  }

  const appId = Deno.env.get("INSTAGRAM_APP_ID") || "";
  const secret = Deno.env.get("INSTAGRAM_APP_SECRET") || "";
  const redirect = Deno.env.get("INSTAGRAM_REDIRECT_URI") || "";
  if (!appId || !secret || !redirect) {
    return page("Not connected", "This server has no Instagram app configured yet.", false, 500);
  }

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
      return page("Not connected",
        escape_(String(j1?.error_message || j1?.error?.message || "Instagram would not issue a token.")), false, 400);
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

    const who = j3.username ? "@" + String(j3.username) : "the account";
    return page("Connected",
      `${escape_(who)} is connected. Social Command can now read what it has published — and nothing else.`, true);
  } catch (e) {
    return page("Not connected", escape_(String((e as Error).message || e)), false, 500);
  }
});

// The only thing on that page that did not come from us is an error string
// relayed from Meta. It goes into HTML, so it gets escaped.
function escape_(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").slice(0, 300);
}
