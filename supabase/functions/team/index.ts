import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Team & access — the founder-only door to venia_members.
//
// WHY THIS EXISTS AT ALL, given venia_members has RLS that already restricts
// writes to founders: creating the LOGIN needs the service role. A browser
// cannot create a Supabase Auth user, so without this a grant would be a row
// that lets nobody in — access to a door that does not exist.
//
// HOW THIS DIFFERS FROM agent-portal, deliberately:
// agent-portal exists so a freelance agent NEVER holds a Supabase JWT — her
// credential unlocks that one function and nothing else. A team member is a
// different animal: they need ordinary read/write across a whole module, which
// is exactly what RLS expresses and what re-projecting every module through a
// function could not. So a member IS `authenticated`, and the policies on
// venia_module_data are what stand between them and the rest of the workspace.
// Those policies are tested (a sales editor cannot read money, cannot write
// money, and cannot grant themselves money). That is the trade, made knowingly.
//
// Actions (POST JSON, founder JWT required on every one):
//   {action:'list'}                          -> everyone, their modules, login state
//   {action:'grant', email, modules[], role} -> add/replace module grants
//   {action:'revoke', email, module}         -> take one module away
//   {action:'remove', email}                 -> take every module away
//   {action:'setpw', email, password}        -> create the login, or reset it
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

// THE FOUNDERS, BY NAME — not by domain.
// agent-portal gates on `@veniacollection.com`, which is right for it because
// no agent has one. It would be catastrophic here: the first thing a founder
// does with this screen is give a colleague a veniacollection.com address, and
// a domain check would hand that colleague the power to grant themselves every
// module. The list matches venia_is_founder() in the database exactly.
const FOUNDERS = ["keeter@veniacollection.com", "christine@veniacollection.com"];
const MODULES = ["home", "product", "growth", "sales", "money", "brainstorm", "settings"];
// 'legacy' is deliberately absent: it holds a pre-module store spanning sales,
// growth and product in one string, so it is founders-only and not grantable.
const ROLES = ["owner", "editor", "viewer"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const b = await req.json().catch(() => ({}));
    const action = String(b.action || "list");
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    let founder = "";
    try {
      const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (jwt) {
        const { data } = await admin.auth.getUser(jwt);
        const em = String(data?.user?.email || "").toLowerCase();
        if (FOUNDERS.includes(em)) founder = em;
      }
    } catch (_) { /* not signed in */ }
    if (!founder) return json({ error: "founders only" }, 403);

    const email = String(b.email || "").trim().toLowerCase();
    const okEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

    // Who already has a login. A grant with no account is a row that lets
    // nobody in, so the screen has to be able to say which is which.
    const logins = async () => {
      const seen = new Map<string, { id: string; last: string | null }>();
      for (let page = 1; page <= 10; page++) {
        const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        const users = data?.users || [];
        for (const u of users) {
          if (u.email) seen.set(u.email.toLowerCase(), { id: u.id, last: u.last_sign_in_at ?? null });
        }
        if (users.length < 200) break;
      }
      return seen;
    };

    if (action === "list") {
      const { data: rows, error } = await admin.from("venia_members")
        .select("email, module, role, created_at").order("email").order("module");
      if (error) return json({ error: "could not read members" }, 500);
      const accounts = await logins();
      const people: Record<string, Record<string, unknown>> = {};
      for (const r of rows || []) {
        const e = String(r.email).toLowerCase();
        if (!people[e]) {
          const a = accounts.get(e);
          people[e] = { email: e, founder: FOUNDERS.includes(e), modules: {},
                        hasLogin: !!a, lastSignIn: a?.last || null };
        }
        (people[e].modules as Record<string, string>)[String(r.module)] = String(r.role);
      }
      return json({ people: Object.values(people), modules: MODULES, roles: ROLES, founders: FOUNDERS });
    }

    if (action === "grant") {
      if (!okEmail(email)) return json({ error: "that does not look like an email" }, 400);
      const role = String(b.role || "editor");
      if (!ROLES.includes(role)) return json({ error: "unknown role" }, 400);
      const mods = (Array.isArray(b.modules) ? b.modules : []).map(String).filter((m) => MODULES.includes(m));
      if (!mods.length) return json({ error: "pick at least one module" }, 400);
      // 'home' comes with any grant. Without it a member signs in to a Today
      // screen that cannot load, which reads as broken rather than restricted.
      if (!mods.includes("home")) mods.push("home");
      const rows = mods.map((m) => ({ email, module: m, role: m === "home" ? "viewer" : role, created_by: founder }));
      const { error } = await admin.from("venia_members").upsert(rows, { onConflict: "email,module" });
      if (error) return json({ error: "could not save the grant" }, 500);
      // Modules NOT in this set are revoked, so the screen is the whole truth
      // about what someone can reach rather than an append-only pile.
      await admin.from("venia_members").delete().eq("email", email).not("module", "in", `(${mods.join(",")})`);
      return json({ ok: true, modules: mods });
    }

    if (action === "revoke") {
      const module = String(b.module || "");
      if (!okEmail(email) || !MODULES.includes(module)) return json({ error: "bad request" }, 400);
      if (FOUNDERS.includes(email)) return json({ error: "a founder's access cannot be revoked here" }, 400);
      const { error } = await admin.from("venia_members").delete().eq("email", email).eq("module", module);
      if (error) return json({ error: "could not revoke" }, 500);
      return json({ ok: true });
    }

    if (action === "remove") {
      if (!okEmail(email)) return json({ error: "bad request" }, 400);
      if (FOUNDERS.includes(email)) return json({ error: "a founder cannot be removed here" }, 400);
      const { error } = await admin.from("venia_members").delete().eq("email", email);
      if (error) return json({ error: "could not remove" }, 500);
      // The Supabase Auth account is deliberately LEFT ALONE. Deleting it is
      // irreversible and is not what "revoke access" means; with no grants the
      // login opens nothing. Say so rather than doing something bigger quietly.
      return json({ ok: true, loginKept: true });
    }

    if (action === "setpw") {
      const pw = String(b.password || "");
      if (!okEmail(email)) return json({ error: "that does not look like an email" }, 400);
      if (pw.length < 10) return json({ error: "password must be at least 10 characters" }, 400);
      if (FOUNDERS.includes(email)) {
        return json({ error: "use Settings → Security to change a founder's own password" }, 400);
      }
      const accounts = await logins();
      const existing = accounts.get(email);
      if (existing) {
        const { error } = await admin.auth.admin.updateUserById(existing.id, { password: pw });
        if (error) return json({ error: "could not reset the password" }, 500);
        return json({ ok: true, created: false });
      }
      const { error } = await admin.auth.admin.createUser({
        email, password: pw, email_confirm: true,
      });
      if (error) return json({ error: String(error.message || "could not create the login") }, 500);
      return json({ ok: true, created: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
