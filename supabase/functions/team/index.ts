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
//   {action:'setagent', email, canWrite}     -> may Enigma change things for them
//   {action:'setpw', email, password}        -> create the login, or reset it
//   Build 701:
//   {action:'grant', email, grants:{module:role}, preset}
//                                            -> a role preset: a level per module
//   {action:'pause', email, paused}          -> pause or resume someone's access
//   {action:'link', email, base}             -> a one-hour sign-in link that
//                                               lets them choose their password
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
// 'pattern-cad' (Dr4ft, Build 684) is an app module with no venia_module_data
// row; its grant is read by venia_module_role(m := 'pattern-cad') in the
// pattern-cad function and by veniaPatternCadOn() in the app.
const MODULES = ["home", "product", "growth", "sales", "money", "brainstorm", "pattern-cad", "settings"];
// 'legacy' is deliberately absent: it holds a pre-module store spanning sales,
// growth and product in one string, so it is founders-only and not grantable.
// 'catalog' is absent too, for the opposite reason: it is the cost-stripped
// line, implied by ANY grant, and never something to tick on its own.
const ROLES = ["owner", "editor", "viewer"];
// Build 701: where a sign-in link may send someone. Only VENIA's own address,
// never a host a request names, so a link can't be pointed somewhere else.
const PUBLIC_BASE = "https://creator.veniacollection.com";
// A role preset is only a NAME for the set of grants; the grants themselves
// are what the database enforces. Free text, kept short.
const cleanPreset = (v: unknown) => String(v || "").replace(/[^\w &'\-]/g, "").trim().slice(0, 40);

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
      // May the assistant make changes on their behalf? Absent row = yes, which
      // grants nothing: every write still passes their module grant, their role
      // and RLS. The switch can only ever take away.
      const { data: pol } = await admin.from("venia_agent_policy").select("email, can_write");
      const agentOff = new Set((pol || []).filter((r) => r.can_write === false)
        .map((r) => String(r.email).toLowerCase()));
      // Build 701: role name and pause state. An older database without the
      // table just answers nothing here, and everyone reads as not paused.
      const { data: profs } = await admin.from("venia_member_profiles").select("email, preset, paused, paused_at");
      const prof = new Map((profs || []).map((p) => [String(p.email).toLowerCase(), p]));
      const people: Record<string, Record<string, unknown>> = {};
      for (const r of rows || []) {
        const e = String(r.email).toLowerCase();
        if (!people[e]) {
          const a = accounts.get(e);
          people[e] = { email: e, founder: FOUNDERS.includes(e), modules: {},
                        hasLogin: !!a, lastSignIn: a?.last || null,
                        agentWrite: FOUNDERS.includes(e) ? true : !agentOff.has(e),
                        preset: prof.get(e)?.preset || null,
                        paused: FOUNDERS.includes(e) ? false : !!prof.get(e)?.paused,
                        pausedAt: prof.get(e)?.paused_at || null };
        }
        (people[e].modules as Record<string, string>)[String(r.module)] = String(r.role);
      }
      return json({ people: Object.values(people), modules: MODULES, roles: ROLES, founders: FOUNDERS,
                    features: ["grants", "pause", "link"] });
    }

    if (action === "grant") {
      if (!okEmail(email)) return json({ error: "that does not look like an email" }, 400);
      if (FOUNDERS.includes(email)) return json({ error: "a founder already has everything" }, 400);
      // Build 701: a preset sends a level per module ({product:'editor', ...});
      // the older form (modules[] + one role) still works.
      const levels: Record<string, string> = {};
      if (b.grants && typeof b.grants === "object" && !Array.isArray(b.grants)) {
        for (const [m, r] of Object.entries(b.grants as Record<string, unknown>)) {
          if (!MODULES.includes(m)) continue;
          if (!ROLES.includes(String(r))) return json({ error: "unknown role" }, 400);
          levels[m] = String(r);
        }
      } else {
        const role = String(b.role || "editor");
        if (!ROLES.includes(role)) return json({ error: "unknown role" }, 400);
        for (const m of (Array.isArray(b.modules) ? b.modules : []).map(String)) {
          if (MODULES.includes(m)) levels[m] = role;
        }
      }
      const mods = Object.keys(levels);
      if (!mods.filter((m) => m !== "home").length) return json({ error: "pick at least one module" }, 400);
      // 'home' comes with any grant. Without it a member signs in to a Today
      // screen that cannot load, which reads as broken rather than restricted.
      if (!mods.includes("home")) mods.push("home");
      const rows = mods.map((m) => ({ email, module: m, role: m === "home" ? "viewer" : levels[m], created_by: founder }));
      const { error } = await admin.from("venia_members").upsert(rows, { onConflict: "email,module" });
      if (error) return json({ error: "could not save the grant" }, 500);
      // Modules NOT in this set are revoked, so the screen is the whole truth
      // about what someone can reach rather than an append-only pile.
      await admin.from("venia_members").delete().eq("email", email).not("module", "in", `(${mods.join(",")})`);
      // The preset's name, for the People screen. Best effort: the grant above
      // is what matters, and it has already been saved.
      if (b.preset !== undefined) {
        await admin.from("venia_member_profiles").upsert(
          { email, preset: cleanPreset(b.preset) || null, updated_by: founder, updated_at: new Date().toISOString() },
          { onConflict: "email" });
      }
      return json({ ok: true, modules: mods, grants: Object.fromEntries(rows.map((r) => [r.module, r.role])) });
    }

    // Flip the one agent switch. Founders are excluded on purpose: a founder
    // turning their own assistant off here would be indistinguishable, at the
    // point of use, from the whole permission system being broken.
    if (action === "setagent") {
      if (!okEmail(email)) return json({ error: "bad request" }, 400);
      if (FOUNDERS.includes(email)) return json({ error: "a founder's assistant is always on" }, 400);
      const canWrite = b.canWrite !== false;
      const { error } = await admin.from("venia_agent_policy").upsert(
        { email, can_write: canWrite, updated_by: founder, updated_at: new Date().toISOString() },
        { onConflict: "email" });
      if (error) return json({ error: "could not save that" }, 500);
      return json({ ok: true, canWrite });
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

    // Build 701: pause keeps every grant and the login, and shuts the door:
    // venia_has_access() and venia_module_role() answer nothing while paused.
    if (action === "pause") {
      if (!okEmail(email)) return json({ error: "bad request" }, 400);
      if (FOUNDERS.includes(email)) return json({ error: "a founder cannot be paused" }, 400);
      const paused = b.paused !== false;
      const { error } = await admin.from("venia_member_profiles").upsert(
        { email, paused, paused_at: paused ? new Date().toISOString() : null,
          updated_by: founder, updated_at: new Date().toISOString() },
        { onConflict: "email" });
      if (error) return json({ error: "could not save that (is the Build 701 database update in?)" }, 500);
      return json({ ok: true, paused });
    }

    // Build 701: a sign-in link instead of a password read out loud. It opens
    // VENIA OS's "choose a password" screen, works once, and lasts an hour.
    // Supabase's own mailer only reaches this project's team, so the link is
    // handed back for the founder to send however they like.
    if (action === "link") {
      if (!okEmail(email)) return json({ error: "that does not look like an email" }, 400);
      if (FOUNDERS.includes(email)) return json({ error: "a founder resets from the sign-in screen" }, 400);
      const { data: has } = await admin.from("venia_members").select("module").eq("email", email).limit(1);
      if (!has || !has.length) return json({ error: "give them access first" }, 400);
      const accounts = await logins();
      let created = false;
      if (!accounts.get(email)) {
        // A login with a random password nobody knows; the link sets the real one.
        const rnd = crypto.getRandomValues(new Uint8Array(24));
        const pw = btoa(String.fromCharCode(...rnd));
        const { error } = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
        if (error) return json({ error: String(error.message || "could not create the login") }, 500);
        created = true;
      }
      const { data, error } = await admin.auth.admin.generateLink({
        type: "recovery", email, options: { redirectTo: PUBLIC_BASE + "/?reset=1&team" },
      });
      const link = (data as { properties?: { action_link?: string } })?.properties?.action_link || "";
      if (error || !link) return json({ error: "could not make a link" }, 500);
      return json({ ok: true, link, created, expiresInMinutes: 60 });
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
