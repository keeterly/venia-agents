import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Remote signing for a press pull — the only server a stylist ever talks to.
//
// WHAT THIS IS FOR: the signature pad lives on the founder's device, so a pull
// going to someone who is not in the room could never be signed. This serves
// one frozen pull to one token holder and takes one signature back.
//
// WHAT IT DELIBERATELY CANNOT DO: reach the workspace. The snapshot was frozen
// into venia_pull_sign when the link was minted, so there is no query here that
// could return another pull, a style, a cost or a buyer — not filtered out,
// genuinely not reachable. The service role is used for exactly one row, keyed
// by a token the caller must already hold.
//
// Actions (POST JSON, no login — the token IS the credential):
//   {action:'get',  token}                  -> the frozen pull, or why not
//   {action:'sign', token, name, image}     -> record the signature
//
// The signature's timestamp, IP and user agent are stamped HERE. A value the
// browser supplies is a value the browser can invent, and those three fields
// are the difference between a record and a drawing.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

// A signature is a PNG from a canvas. Cap it: a megabyte of "signature" is not
// a signature, and this row is read by a page with no login.
const MAX_IMAGE = 400_000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const b = await req.json().catch(() => ({}));
    const action = String(b.action || "get");
    const token = String(b.token || "").trim();
    // Tokens are minted as 32 hex characters. Anything else is not a typo, it
    // is someone trying keys, and it gets the same answer as a wrong one.
    if (!/^[a-f0-9]{24,64}$/.test(token)) return json({ error: "notfound" }, 404);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const { data: row, error } = await admin.from("venia_pull_sign")
      .select("token, pull_id, snapshot, signature, expires_at, signed_at, revoked")
      .eq("token", token).maybeSingle();
    if (error) return json({ error: "unavailable" }, 500);
    // One answer for "no such token" and "revoked token": a different answer
    // for each is a way to find out which tokens are real.
    if (!row || row.revoked) return json({ error: "revoked" }, 404);

    const expired = Date.parse(row.expires_at) < Date.now();

    if (action === "get") {
      return json({
        pull: row.snapshot,
        signed: !!row.signed_at,
        signedAt: row.signed_at || null,
        signedName: row.signature?.name || null,
        expired,
        expiresAt: row.expires_at,
      });
    }

    if (action === "sign") {
      // Order matters: say the most useful true thing. "Already signed" is not
      // an error to the person who just signed on a flaky connection and
      // tapped again — it is the confirmation they were looking for.
      if (row.signed_at) {
        return json({ ok: true, already: true, signedAt: row.signed_at, name: row.signature?.name || "" });
      }
      if (expired) return json({ error: "expired" }, 410);

      const name = String(b.name || "").trim().slice(0, 120);
      const image = String(b.image || "");
      if (name.length < 2) return json({ error: "Type the name of the person signing" }, 400);
      if (!image.startsWith("data:image/png;base64,")) return json({ error: "The signature did not come through" }, 400);
      if (image.length > MAX_IMAGE) return json({ error: "That signature image is too large" }, 400);

      // Stamped here, not sent from the browser.
      const at = new Date().toISOString();
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
      const ua = (req.headers.get("user-agent") || "").slice(0, 300);

      const { error: wErr } = await admin.from("venia_pull_sign")
        .update({ signature: { name, image, at, ip, ua }, signed_at: at })
        .eq("token", token)
        // Belt to the check above: two taps racing each other cannot both win,
        // so the first signature is the one that stands.
        .is("signed_at", null);
      if (wErr) return json({ error: "Could not record the signature" }, 500);

      return json({ ok: true, signedAt: at, name });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
