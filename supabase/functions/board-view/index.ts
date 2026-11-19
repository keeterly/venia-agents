import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Board view link (Build 660). Given a link token, returns ONE board to look
// at: its title, its drawing, and its pictures as signed addresses that stop
// working after ten minutes. Read-only by construction: this function only
// reads, and the person holding the link never gets a key to the workspace.
//
// A link answers only while it is on (not turned off) and not past its end
// date, and only for a board that isn't in Trash. Comments, who made what and
// who it's shared with are never sent.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const BUCKET = "venia-boards";
const SIGNED_FOR = 600; // seconds

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "gone" }, 404);
  try {
    const b = await req.json().catch(() => ({}));
    const token = String((b && b.token) || "").trim();
    // Tokens are 32 hex characters; anything else gets the same answer as a
    // wrong or turned-off one.
    if (!/^[a-f0-9]{32}$/.test(token)) return json({ error: "gone" }, 404);

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    const { data: link, error: le } = await sb.from("venia_board_links")
      .select("board_id, expires_at, revoked_at").eq("token", token).maybeSingle();
    if (le) return json({ error: "unavailable" }, 500);
    if (!link || link.revoked_at || (link.expires_at && Date.parse(link.expires_at) <= Date.now())) return json({ error: "gone" }, 404);

    const { data: board, error: be } = await sb.from("venia_boards")
      .select("id, title, scene, updated_at, trashed_at").eq("id", link.board_id).maybeSingle();
    if (be) return json({ error: "unavailable" }, 500);
    if (!board || board.trashed_at) return json({ error: "gone" }, 404);

    const scene = (board.scene || {}) as any;
    const elements = (Array.isArray(scene.elements) ? scene.elements : []).filter((e: any) => e && !e.isDeleted);
    const fileIds = [...new Set(elements.filter((e: any) => e.type === "image" && e.fileId).map((e: any) => String(e.fileId)))];

    const files: { id: string; mime: string; url: string }[] = [];
    if (fileIds.length) {
      const { data: rows } = await sb.from("venia_board_files")
        .select("id, path, mime").eq("board_id", board.id).in("id", fileIds);
      const list = (rows || []).filter((r: any) => typeof r.path === "string" && r.path.startsWith("main/" + board.id + "/"));
      if (list.length) {
        const { data: signed } = await sb.storage.from(BUCKET).createSignedUrls(list.map((r: any) => r.path), SIGNED_FOR);
        const byPath = new Map((signed || []).map((s: any) => [s.path, s.signedUrl]));
        for (const r of list as any[]) { const url = byPath.get(r.path); if (url) files.push({ id: r.id, mime: r.mime || "image/png", url }); }
      }
    }

    return json({
      title: board.title || "Board",
      updated_at: board.updated_at,
      expires_at: link.expires_at,
      background: (scene.appState && scene.appState.viewBackgroundColor) || null,
      elements,
      files,
    });
  } catch (_e) {
    // No error text to a stranger: it can carry internals.
    return json({ error: "unavailable" }, 500);
  }
});
