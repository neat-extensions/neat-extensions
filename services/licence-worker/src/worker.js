// Licence delivery, Cloudflare Worker (free plan). Stripe's hosted checkout
// (Payment Link) redirects buyers to /success?session_id={CHECKOUT_SESSION_ID}.
// The Worker asks Stripe whether that session is really paid for our product,
// signs a licence key (ECDSA P-256, offline-verifiable by the extension), shows
// it on a clean page and emails it once. The same session always gets the same
// key (stored in KV), so refreshing the page or a lost email never costs a sale.
// Privacy: the KV record holds the key and its random subject id (for refunds),
// and the buyer's email only until the key email has gone out.
//
// We never see card details: Stripe handles payment (cards, Apple Pay, Google Pay).
// Bindings (wrangler.toml): KV LICENCES; vars PRODUCT, STRIPE_PRICE_ID, MAIL_FROM,
// MAIL_FROM_NAME, SUPPORT_URL; secrets STRIPE_SECRET_KEY, LICENCE_PRIVATE_JWK,
// BREVO_API_KEY (optional: without it the key is only shown, not emailed).
import { encodeLicence, LICENCE_VERSION, toB64url } from "../../../packages/engine/src/licence.js";
// Abuse guard: unknown or unpaid session ids are remembered briefly, so a script
// trying random ids can't turn each request into a Stripe API call.
const NEGATIVE_TTL = 600;
import { BRAND } from "../../../brand.config.js";

const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]{10,240}$/;
const STRIPE = "https://api.stripe.com/v1";
const BREVO = "https://api.brevo.com/v3/smtp/email";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "GET") return text(405, "Method not allowed");
    if (url.pathname === "/") return text(200, `${BRAND} licence service`);
    if (url.pathname !== "/success") return text(404, "Not found");
    const missing = ["STRIPE_SECRET_KEY", "LICENCE_PRIVATE_JWK", "STRIPE_PRICE_ID"].filter((k) => !env[k] || /REPLACE/.test(env[k]));
    if (missing.length) {
      console.error("licence worker not configured:", missing.join(", "));
      return page(503, "Almost ready", `<p>The key service isn't switched on yet. Your payment is safe — write to us: ${support(env)}.</p>`);
    }
    const id = url.searchParams.get("session_id") || "";
    if (!SESSION_RE.test(id)) return page(400, "That link isn't complete", `<p>Open the link from your payment confirmation again, or write to us: ${support(env)}.</p>`);
    try {
      return await success(id, env, ctx);
    } catch (e) {
      console.error("licence error", e && e.message);
      return page(502, "We couldn't reach the payment system", `<p>Your payment is safe. Refresh this page in a minute. If it keeps happening, write to us: ${support(env)} and quote <code>${esc(id.slice(-12))}</code>.</p>`);
    }
  },
};

async function success(id, env, ctx) {
  const product = env.PRODUCT || "record";
  const kvKey = `session:${id}`;
  let rec = await env.LICENCES.get(kvKey, "json");
  if (!rec) {
    const no = await env.LICENCES.get(`no:${id}`);
    if (no) return page(Number(no) || 404, no === "402" ? "Payment not finished yet" : "We can't find that payment", `<p>Refresh this page in a few minutes. If you paid, write to us: ${support(env)}.</p>`);
    const remember = (status) => env.LICENCES.put(`no:${id}`, String(status), { expirationTtl: NEGATIVE_TTL });
    const res = await fetch(`${STRIPE}/checkout/sessions/${encodeURIComponent(id)}?expand[]=line_items`, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
    if (res.status === 404) {
      await remember(404);
      return page(404, "We can't find that payment", `<p>If you paid, write to us: ${support(env)}.</p>`);
    }
    if (!res.ok) throw new Error(`stripe ${res.status}`);
    const s = await res.json();
    // "no_payment_required" = a 100% discount code: still a valid order.
    if (s.status !== "complete" || !["paid", "no_payment_required"].includes(s.payment_status)) {
      await remember(402);
      return page(402, "Payment not finished yet", "<p>Stripe hasn't confirmed this payment yet. Refresh this page in a few minutes.</p>");
    }
    const items = (s.line_items && s.line_items.data) || [];
    if (!items.some((li) => li.price && li.price.id === env.STRIPE_PRICE_ID)) return page(400, "That payment isn't for this product", `<p>Write to us: ${support(env)}.</p>`);
    const email = (s.customer_details && s.customer_details.email) || "";
    // The key's subject is random: it identifies the purchase (for a refund) without saying who bought it.
    const sub = toB64url(crypto.getRandomValues(new Uint8Array(12)));
    const key = await sign(env.LICENCE_PRIVATE_JWK, { product, sub });
    rec = { key, sub, email, issued: new Date().toISOString().slice(0, 10), emailed: false };
    await env.LICENCES.put(kvKey, JSON.stringify(rec));
  }
  if (!rec.emailed && rec.email && env.BREVO_API_KEY) {
    const send = mail(env, rec).then(async (ok) => {
      // Sent: the email address is no longer needed, so it isn't kept.
      if (ok) await env.LICENCES.put(kvKey, JSON.stringify({ ...rec, email: "", emailed: true }));
    });
    if (ctx && ctx.waitUntil) ctx.waitUntil(send);
    else await send;
  }
  return keyPage(rec, env);
}

async function sign(privateJwkText, { product, sub }) {
  const jwk = JSON.parse(privateJwkText);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const payload = { v: LICENCE_VERSION, product, issued: new Date().toISOString().slice(0, 10), seats: 3, sub };
  return encodeLicence(payload, async (bytes) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes)));
}

async function mail(env, rec) {
  const product = `${BRAND} Record`;
  const body = {
    sender: { name: env.MAIL_FROM_NAME || BRAND, email: env.MAIL_FROM },
    to: [{ email: rec.email }],
    subject: `Your ${product} Pro key`,
    textContent: `Thank you for buying ${product} Pro.\n\nYour key:\n${rec.key}\n\nTo unlock: click the ${product} icon in Chrome, press "Pro", paste the key, press "Unlock Pro".\nComputers signed in to the same Chrome profile unlock by themselves. The licence covers up to 3 of your own computers.\n\nKeep this email: it's your proof of purchase.`,
  };
  const res = await fetch(BREVO, { method: "POST", headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  return !!res && res.ok;
}

// ---------------------------------------------------------------- pages
/** k***@gmail.com — enough to recognise, not enough to harvest from a shared link. */
const mask = (e) => e.replace(/^(.)[^@]*(@.*)$/, "$1***$2");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const support = (env) => (env.SUPPORT_URL ? `<a href="${esc(env.SUPPORT_URL)}">${esc(env.SUPPORT_URL.replace(/^https?:\/\//, ""))}</a>` : "the address on your receipt");

const CSS = `:root{color-scheme:light dark;--bg:#f6f6f8;--card:#fff;--text:#111114;--muted:#62626d;--accent:#d6363c;--border:rgba(17,17,20,.09)}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--card:#18181b;--text:#f3f3f5;--muted:#a1a1ab;--accent:#e0444a;--border:rgba(255,255,255,.09)}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;width:100%;background:var(--card);border:1px solid var(--border);border-radius:24px;padding:40px 32px;box-shadow:0 18px 48px rgba(0,0,0,.12)}
h1{margin:0 0 8px;font-size:26px;letter-spacing:-.01em}p{margin:8px 0;color:var(--muted)}
.key{margin:20px 0 12px;padding:16px;border-radius:12px;background:var(--bg);border:1px solid var(--border);font:13px/1.5 ui-monospace,Consolas,monospace;word-break:break-all;color:var(--text)}
button{height:48px;padding:0 24px;border:0;border-radius:999px;background:var(--accent);color:#fff;font:650 16px/1 inherit;cursor:pointer}
ol{padding-left:20px;color:var(--text)}li{margin:6px 0}code{font-size:13px}`;

const COPY_JS = `document.getElementById("copy").addEventListener("click",function(){var k=document.getElementById("key").textContent;navigator.clipboard.writeText(k).then(function(){document.getElementById("copy").textContent="Copied";});});`;

async function headers(status, withScript) {
  const h = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${await sha(CSS)}'; ${withScript ? `script-src 'sha256-${await sha(COPY_JS)}'; ` : ""}base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
  return { status, headers: h };
}
async function sha(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  let b = "";
  for (const x of new Uint8Array(d)) b += String.fromCharCode(x);
  return btoa(b);
}

async function page(status, title, body) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`, await headers(status, false));
}

async function keyPage(rec, env) {
  const product = `${BRAND} Record`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your ${esc(product)} Pro key</title><style>${CSS}</style></head><body><main>
<h1>Thank you! Here's your Pro key</h1>
<p>${(rec.email || rec.emailed) && env.BREVO_API_KEY ? `We've also emailed it${rec.email ? ` to <strong>${esc(mask(rec.email))}</strong>` : ""}.` : "Copy it now and keep it somewhere safe."}</p>
<div class="key" id="key">${esc(rec.key)}</div>
<button id="copy" type="button">Copy key</button>
<ol><li>Click the <strong>${esc(product)}</strong> icon in Chrome.</li><li>Press <strong>Pro</strong>.</li><li>Paste the key and press <strong>Unlock Pro</strong>.</li></ol>
<p>Your other computers signed in to the same Chrome profile unlock by themselves. The licence covers up to 3 of your own computers.</p>
</main><script>${COPY_JS}</script></body></html>`;
  return new Response(html, await headers(200, true));
}

function text(status, body) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
