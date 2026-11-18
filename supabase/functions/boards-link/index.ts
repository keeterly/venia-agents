import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Boards: what a web link is, for a link card. A browser can't read another
// site's page, so this reads it once and hands back the title, picture, site
// name and a line of description. Nothing is stored here.
//
// POST {url} with the person's own session. Only for people who can read
// Boards. Only public http(s) pages: private and local addresses are refused,
// redirects are followed by hand (three at most) and checked again, and the
// read stops at 1.5 MB or 8 seconds.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function privateV4(ip: string) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => isNaN(n))) return true;
  return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224;
}
function privateV6(ip: string) {
  const s = ip.toLowerCase();
  return s === "::1" || s === "::" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80") || s.startsWith("::ffff:");
}
async function publicHost(host: string) {
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !privateV4(host);
  if (host.includes(":")) return !privateV6(host.replace(/^\[|\]$/g, ""));
  try {
    const a = await Deno.resolveDns(host, "A").catch(() => [] as string[]);
    const aaaa = await Deno.resolveDns(host, "AAAA").catch(() => [] as string[]);
    if (!a.length && !aaaa.length) return false;
    return a.every((ip) => !privateV4(ip)) && aaaa.every((ip) => !privateV6(ip));
  } catch (_) { return false; }
}

function decode(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/\s+/g, " ").trim();
}
function meta(html: string, names: string[]) {
  for (const n of names) {
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']`, "i");
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, "i");
    const m = html.match(re1) || html.match(re2);
    if (m && m[1].trim()) return decode(m[1]);
  }
  return "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const b = await req.json().catch(() => ({}));
    let url: URL;
    try { url = new URL(String((b && b.url) || "")); } catch (_) { return json({ error: "not a link" }, 400); }

    const auth = req.headers.get("Authorization") || "";
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      auth: { persistSession: false }, global: { headers: { Authorization: auth } },
    });
    const { data: may } = await supa.rpc("venia_boards_can", { mode: "read" });
    if (may !== true) return json({ error: "sign in first" }, 401);

    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      if (!/^https?:$/.test(url.protocol) || (url.port && !["80", "443"].includes(url.port))) return json({ error: "not a public page" }, 400);
      if (!(await publicHost(url.hostname))) return json({ error: "not a public page" }, 400);
      res = await fetch(url.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Boards link preview)", "Accept": "text/html,application/xhtml+xml,image/*;q=0.8" },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = new URL(res.headers.get("location")!, url);
        await res.body?.cancel();
        continue;
      }
      break;
    }
    if (!res || !res.ok) return json({ error: "page unavailable" }, 502);

    const type = res.headers.get("content-type") || "";
    const site = url.hostname.replace(/^www\./, "");
    if (type.startsWith("image/")) { await res.body?.cancel(); return json({ kind: "image", url: url.toString(), image: url.toString(), site }); }
    if (!type.includes("html")) { await res.body?.cancel(); return json({ kind: "page", url: url.toString(), site, title: decodeURIComponent(url.pathname.split("/").pop() || site) }); }

    // read at most 1.5 MB; the head is all we need
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    while (size < 1_500_000) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value); size += value.length;
      const so = new TextDecoder().decode(value);
      if (/<\/head>/i.test(so)) break;
    }
    try { await reader.cancel(); } catch (_) { /* done */ }
    const all = new Uint8Array(size); let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.length; }
    const html = new TextDecoder().decode(all);

    const title = meta(html, ["og:title", "twitter:title"]) || decode((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "");
    let image = meta(html, ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]);
    if (image) { try { image = new URL(image, url).toString(); } catch (_) { image = ""; } }
    if (image && !image.startsWith("https://")) image = "";
    return json({
      kind: "page",
      url: url.toString(),
      title: title.slice(0, 200),
      site: (meta(html, ["og:site_name", "application-name"]) || site).slice(0, 80),
      description: meta(html, ["og:description", "twitter:description", "description"]).slice(0, 300),
      image,
    });
  } catch (_e) {
    return json({ error: "page unavailable" }, 502);
  }
});
