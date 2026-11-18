import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Boards: empty one board out of Trash, for good.
//
// WHY A FUNCTION and not a delete policy on venia_boards: the database stays
// add-only. No browser can remove a board or an image by itself; the only way
// is this door, which removes exactly one board that is already in Trash, for
// someone the database itself says may purge (venia_boards_can('purge'):
// a founder, or the Brainstorm owner). Everything it removes is listed in
// venia_boards_purged first, so there is a record of what went and who sent it.
//
// POST {boardId}  with the person's own session as Authorization.
// Boards inside the purged board are kept: they move to the top level.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
const BUCKET = "venia-boards";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const b = await req.json().catch(() => ({}));
    const boardId = String((b && b.boardId) || "").trim();
    if (!/^[\w-]{1,80}$/.test(boardId)) return json({ error: "no such board" }, 404);

    const auth = req.headers.get("Authorization") || "";
    const url = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    // Who is asking, and may they purge? Asked as them, so the answer comes
    // from the same function every Boards policy uses.
    const jwt = auth.replace(/^Bearer\s+/i, "");
    const { data: who } = await admin.auth.getUser(jwt);
    const email = String(who?.user?.email || "").toLowerCase();
    if (!email) return json({ error: "sign in first" }, 401);
    const asThem = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      auth: { persistSession: false },
      global: { headers: { Authorization: auth } },
    });
    const { data: may, error: ce } = await asThem.rpc("venia_boards_can", { mode: "purge" });
    if (ce || may !== true) return json({ error: "only an owner can delete boards for good" }, 403);

    const { data: board } = await admin.from("venia_boards")
      .select("id, workspace_id, title, trashed_at").eq("id", boardId).maybeSingle();
    if (!board) return json({ error: "no such board" }, 404);
    if (!board.trashed_at) return json({ error: "move it to Trash first" }, 409);

    const { data: files } = await admin.from("venia_board_files").select("path").eq("board_id", boardId);
    const paths = (files || []).map((f: { path: string }) => f.path);

    // The record first, so nothing goes without a trace.
    const { error: le } = await admin.from("venia_boards_purged").upsert({
      id: boardId, workspace_id: board.workspace_id, title: board.title,
      files: paths.length, purged_by: email, purged_at: new Date().toISOString(),
    });
    if (le) return json({ error: "couldn't record the delete" }, 500);

    // Keep any boards that lived inside it.
    await admin.from("venia_boards").update({ parent_id: null }).eq("parent_id", boardId);

    const thumb = `${board.workspace_id}/thumbs/${boardId}.png`;
    for (let i = 0; i < paths.length + 1; i += 100) {
      const chunk = paths.concat([thumb]).slice(i, i + 100);
      if (chunk.length) await admin.storage.from(BUCKET).remove(chunk);
    }
    const { error: fe } = await admin.from("venia_board_files").delete().eq("board_id", boardId);
    if (fe) return json({ error: "couldn't clear its images" }, 500);
    const { error: be } = await admin.from("venia_boards").delete().eq("id", boardId).not("trashed_at", "is", null);
    if (be) return json({ error: "couldn't delete the board" }, 500);

    return json({ ok: true, files: paths.length });
  } catch (_e) {
    return json({ error: "unavailable" }, 500);
  }
});
