// The licence Worker, run in Node against a fake Stripe, a fake mail API and an in-memory KV.
import { test, expect } from "@playwright/test";
import worker from "../../services/licence-worker/src/worker.js";
import { verifyLicence } from "../../packages/engine/src/licence.js";
import { generateLicenceKeyPair } from "../../scripts/licence-sign.mjs";

const SESSION = "cs_test_a1B2c3D4e5F6g7H8i9J0";
let keys;
let realFetch;
test.beforeAll(async () => {
  keys = await generateLicenceKeyPair();
  realFetch = globalThis.fetch;
});
test.afterEach(() => (globalThis.fetch = realFetch));

function kv() {
  const m = new Map();
  return { m, get: async (k, type) => (m.has(k) ? (type === "json" ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => m.set(k, v) };
}
function env(overrides = {}) {
  return { LICENCES: kv(), PRODUCT: "record", STRIPE_PRICE_ID: "price_999", STRIPE_SECRET_KEY: "rk_test_x", LICENCE_PRIVATE_JWK: JSON.stringify(keys.privateJwk), BREVO_API_KEY: "brevo", MAIL_FROM: "keys@example.com", SUPPORT_URL: "https://example.com/help", ...overrides };
}
function stub({ session = {}, stripeStatus = 200, mailOk = true } = {}) {
  const calls = { stripe: 0, mail: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://api.stripe.com/")) {
      calls.stripe++;
      expect(init.headers.Authorization).toBe("Bearer rk_test_x");
      expect(u).toContain(encodeURIComponent(SESSION));
      return new Response(JSON.stringify({ status: "complete", payment_status: "paid", customer: "cus_1", customer_details: { email: "buyer@example.com" }, line_items: { data: [{ price: { id: "price_999" } }] }, ...session }), { status: stripeStatus });
    }
    if (u.startsWith("https://api.brevo.com/")) {
      calls.mail.push(JSON.parse(init.body));
      return new Response("{}", { status: mailOk ? 201 : 500 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return calls;
}
const get = (path, e) => worker.fetch(new Request(`https://neat-licence.example.workers.dev${path}`), e, null);
const keyFrom = (html) => /<div class="key" id="key">([^<]+)<\/div>/.exec(html)[1];

test.describe("licence Worker", () => {
  test("a paid session gets a valid key, shown and emailed once", async () => {
    const calls = stub();
    const e = env();
    const res = await get(`/success?session_id=${SESSION}`, e);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Content-Security-Policy")).toMatch(/default-src 'none'/);
    const html = await res.text();
    const key = keyFrom(html);
    expect((await verifyLicence(keys.publicJwk, key, "record")).ok).toBe(true);
    expect(html).toContain("b***@example.com"); // masked
    expect(html).not.toContain("buyer@example.com");
    expect(calls.mail).toHaveLength(1);
    expect(calls.mail[0].to).toEqual([{ email: "buyer@example.com" }]);
    expect(calls.mail[0].textContent).toContain(key);
    // Refresh: same key, Stripe not asked again, no second email, and the email address is gone from storage.
    const again = await get(`/success?session_id=${SESSION}`, e);
    expect(keyFrom(await again.text())).toBe(key);
    expect(calls.stripe).toBe(1);
    expect(calls.mail).toHaveLength(1);
    const stored = JSON.parse(e.LICENCES.m.get(`session:${SESSION}`));
    expect(stored.email).toBe("");
    expect(stored.sub).toMatch(/^[A-Za-z0-9_-]{16}$/);
    // The key's subject is random, not derived from the buyer.
    const payload = JSON.parse(Buffer.from(key.split(".")[0], "base64url").toString());
    expect(payload.sub).toBe(stored.sub);
  });

  test("the page's inline style and script match the CSP hashes", async () => {
    stub();
    const res = await get(`/success?session_id=${SESSION}`, env());
    const html = await res.text();
    const csp = res.headers.get("Content-Security-Policy");
    const hash = async (s) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("base64");
    expect(csp).toContain(`'sha256-${await hash(/<style>([\s\S]*?)<\/style>/.exec(html)[1])}'`);
    expect(csp).toContain(`'sha256-${await hash(/<script>([\s\S]*?)<\/script>/.exec(html)[1])}'`);
  });

  test("a failed email is retried on the next visit", async () => {
    const calls = stub({ mailOk: false });
    const e = env();
    await get(`/success?session_id=${SESSION}`, e);
    stub();
    const calls2 = stub();
    await get(`/success?session_id=${SESSION}`, e);
    expect(calls.mail).toHaveLength(1);
    expect(calls2.mail).toHaveLength(1);
  });

  test("without a mail key the key is still shown", async () => {
    stub();
    const res = await get(`/success?session_id=${SESSION}`, env({ BREVO_API_KEY: "" }));
    expect(await res.text()).toContain("Copy it now");
  });

  test("a 100% discount order still gets a key", async () => {
    stub({ session: { payment_status: "no_payment_required" } });
    const r = await get(`/success?session_id=${SESSION}`, env());
    expect(r.status).toBe(200);
  });

  test("unknown session ids are remembered for a while: no Stripe call per retry", async () => {
    const calls = stub({ stripeStatus: 404 });
    const e = env();
    await get(`/success?session_id=${SESSION}`, e);
    await get(`/success?session_id=${SESSION}`, e);
    expect(calls.stripe).toBe(1);
  });

  test("not configured: a calm page, nothing asked of Stripe", async () => {
    const calls = stub();
    const r = await get(`/success?session_id=${SESSION}`, env({ STRIPE_PRICE_ID: "price_REPLACE_WITH_STRIPE_PRICE_ID" }));
    expect(r.status).toBe(503);
    expect(calls.stripe).toBe(0);
  });

  test("unpaid, wrong product, unknown and malformed sessions get no key", async () => {
    stub({ session: { payment_status: "unpaid" } });
    let r = await get(`/success?session_id=${SESSION}`, env());
    expect(r.status).toBe(402);
    expect(await r.text()).not.toContain('class="key"');
    stub({ session: { line_items: { data: [{ price: { id: "price_other" } }] } } });
    r = await get(`/success?session_id=${SESSION}`, env());
    expect(r.status).toBe(400);
    stub({ stripeStatus: 404 });
    r = await get(`/success?session_id=${SESSION}`, env());
    expect(r.status).toBe(404);
    for (const bad of ["", "cs_test_", "abc", "cs_live_<script>", `${SESSION}/../x`]) {
      r = await get(`/success?session_id=${encodeURIComponent(bad)}`, env());
      expect(r.status, bad).toBe(400);
    }
  });

  test("Stripe down: a calm page, no key, nothing stored", async () => {
    stub({ stripeStatus: 500 });
    const e = env();
    const r = await get(`/success?session_id=${SESSION}`, e);
    expect(r.status).toBe(502);
    expect(await r.text()).toContain("Your payment is safe");
    expect(e.LICENCES.m.size).toBe(0);
  });

  test("other paths and methods", async () => {
    expect((await get("/", env())).status).toBe(200);
    expect((await get("/admin", env())).status).toBe(404);
    expect((await worker.fetch(new Request("https://x.dev/success", { method: "POST" }), env(), null)).status).toBe(405);
  });

  test("the workers.dev address redirects to the custom domain, query intact", async () => {
    stub();
    const res = await get(`/success?session_id=${SESSION}`, env({ PUBLIC_URL: "https://licence.example.com" }));
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`https://licence.example.com/success?session_id=${SESSION}`);
    const direct = await worker.fetch(new Request(`https://licence.example.com/success?session_id=${SESSION}`), env({ PUBLIC_URL: "https://licence.example.com" }), null);
    expect(direct.status).toBe(200);
  });
});
