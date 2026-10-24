// Public website, Cloudflare Worker (free plan). Serves https://neatextensions.com
// from the GitHub Pages site (docs/ on main) by fetching the same path there, so
// `npm run rules:publish` and every push still publish in one step.
//
// Why not a Pages custom domain: GitHub would then 301 every github.io address,
// and the YouTube extension already installed fetches its rules from github.io
// with redirect: "error". So github.io keeps serving the files itself (its HTML
// pages send people here with a canonical link + a one-line script), and this
// Worker serves the same bytes here. www, other hosts and http 301 to https://apex.
import { SITE_URL, OLD_SITE_URL } from "../../../brand.config.js";

const APEX = new URL(SITE_URL).host;
const ORIGIN = OLD_SITE_URL.replace(/\/$/, "");
// Short edge cache: a rules fix reaches neatextensions.com within a minute of GitHub Pages.
const CACHE = { "200-299": 60, 404: 10, "500-599": 0 };

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.host !== APEX || url.protocol !== "https:") return Response.redirect(`https://${APEX}${url.pathname}${url.search}`, 301);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const upstream = await fetch(`${ORIGIN}${url.pathname}${url.search}`, { method: request.method, redirect: "manual", cf: { cacheTtlByStatus: CACHE, cacheEverything: true } });
    const headers = new Headers(upstream.headers);
    // GitHub's own redirects (e.g. /record → /record/) point back at github.io: keep them here.
    const location = headers.get("Location");
    if (location && location.startsWith(ORIGIN)) headers.set("Location", `https://${APEX}${location.slice(ORIGIN.length) || "/"}`);
    for (const h of ["Set-Cookie", "X-GitHub-Request-Id", "X-Fastly-Request-ID", "X-Served-By", "X-Cache", "X-Cache-Hits", "X-Timer", "Via"]) headers.delete(h);
    headers.set("Strict-Transport-Security", "max-age=31536000");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  },
};
