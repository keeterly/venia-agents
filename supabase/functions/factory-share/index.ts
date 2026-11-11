import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { factoryPack } from "./pack.js";

// Factory share endpoint. Given a share token, returns the factory's copy of
// ONE style's tech pack, built by pack.js: the latest issued copy once there is
// one (the working copy before that), with costs, prices, margins and the
// house's own notes taken out, plus only the materials and vendors that pack
// names. The service-role key stays here; the factory never reaches the
// workspace.
//
// Same request and response shape as before (style, bom, pom, materials,
// vendors, label, updated_at), plus `pack` ("issued" | "working") and
// `issued` ({rev, at, note, changes} | null), so older app builds still render.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    let token = "";
    if (req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      token = String((b && b.token) || "").trim();
    } else {
      token = String(new URL(req.url).searchParams.get("token") || "").trim();
    }
    // Tokens are minted as 32 hex characters; anything else gets the same
    // answer as a wrong one.
    if (!/^[a-f0-9]{24,64}$/.test(token)) return json({ error: "revoked" }, 404);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const { data: share, error: se } = await supabase
      .from("venia_shares").select("style_id, label, revoked").eq("token", token).maybeSingle();
    if (se) return json({ error: "lookup failed" }, 500);
    if (!share || share.revoked) return json({ error: "revoked" }, 404);

    const { data: ws } = await supabase
      .from("venia_workspace").select("data, updated_at").eq("id", "main").maybeSingle();
    const d = ws?.data as any;
    if (!d || !Array.isArray(d.styles)) return json({ error: "no data" }, 404);

    const pack = factoryPack(d, share.style_id);
    if (!pack) return json({ error: "style not found" }, 404);

    return json({ ...pack, label: share.label || "", updated_at: ws?.updated_at || null });
  } catch (_e) {
    // No error text to a stranger: it can carry internals.
    return json({ error: "unavailable" }, 500);
  }
});
