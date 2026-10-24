// Stripe setup for Neat Record Pro (Managed Payments = Stripe is merchant of record).
// Idempotent: run it as often as you like, it only creates what's missing.
//
//   node scripts/stripe-setup.mjs                      product + one-time USD 9.99 price
//   WORKER_URL=https://licence.neatextensions.com node scripts/stripe-setup.mjs
//                                                      ...and the Payment Link redirecting to <WORKER_URL>/success
//                                                      (an existing link is re-pointed, never replaced)
//   node scripts/stripe-setup.mjs --check              read-only: lists product, price and link back from the API
//
// Key: .secrets/stripe-restricted.key (git-ignored; or STRIPE_KEY_FILE). Restricted key with
// Products = Write, Payment Links = Write, Checkout Sessions = Read. The key is never printed.
// Non-secret IDs go to services/licence-worker/config/stripe.json (committed), keyed by live/test
// mode, and the price id into wrangler.toml STRIPE_PRICE_ID.
//
// Managed Payments notes (docs.stripe.com/payments/managed-payments): one price in one currency;
// Adaptive Pricing is always on and shows buyers their local currency. Products need an eligible
// tax code. Payment Links must not send automatic_tax, tax_id_collection, payment_method_types,
// custom_text or invoice_creation, and their Managed Payments state can't be changed later.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const KEY_FILE = process.env.STRIPE_KEY_FILE || path.join(ROOT, ".secrets", "stripe-restricted.key");
const CONFIG_FILE = path.join(ROOT, "services", "licence-worker", "config", "stripe.json");
const WRANGLER_FILE = path.join(ROOT, "services", "licence-worker", "wrangler.toml");
const API = "https://api.stripe.com/v1";
const STRIPE_VERSION = "2026-02-25.clover"; // Managed Payments needs 2025-03-31.basil or later

// What we sell. MARK finds our own objects again on re-runs.
const MARK = { neat_item: "record_pro" };
const PRODUCT = {
  name: "Neat Record Pro",
  description: "Pro licence for Neat Record — no time limit, 4K, Share link, webcam bubble, trim, GIF. One payment, no subscription.",
  tax_code: "txcd_10202000", // Downloadable Software - personal use (eligible for Managed Payments)
  metadata: { ...MARK, licence: "one-off key", seats: "3" },
};
const PRICE = { currency: "usd", unit_amount: 999, tax_behavior: "inclusive" }; // buyer pays 9.99, tax included

class StripeSetupError extends Error {}
const fail = (m) => {
  throw new StripeSetupError(m);
};

async function loadKey() {
  let key;
  try {
    key = (await readFile(KEY_FILE, "utf8")).trim();
  } catch {
    fail(`Stripe key missing (${path.relative(ROOT, KEY_FILE)})`);
  }
  if (!/^(rk|sk)_(live|test)_[A-Za-z0-9]+$/.test(key)) fail(`${path.relative(ROOT, KEY_FILE)} doesn't look like a Stripe key`);
  return { key, mode: key.includes("_live_") ? "live" : "test" };
}

/** {a: {b: [x]}} -> a[b][0]=x, Stripe's form encoding. */
function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === "object") form(v, name, out);
    else out.append(name, String(v));
  }
  return out;
}

function client(key) {
  return async function stripe(method, route, params, { idempotencyKey } = {}) {
    const query = method === "GET" && params ? `?${form(params)}` : "";
    const headers = { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_VERSION };
    if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const res = await fetch(`${API}${route}${query}`, { method, headers, body: method === "POST" ? form(params || {}) : undefined });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) fail(`Stripe ${method} ${route}: ${res.status} ${(body.error && body.error.message) || ""}`.trim());
    return body;
  };
}

async function listAll(stripe, route, params = {}) {
  const items = [];
  let starting_after;
  for (;;) {
    const page = await stripe("GET", route, { limit: 100, ...params, starting_after });
    items.push(...page.data);
    if (!page.has_more) return items;
    starting_after = page.data[page.data.length - 1].id;
  }
}

const isOurs = (o) => o.metadata && o.metadata.neat_item === MARK.neat_item;
const priceMatches = (p) => p.active && p.type === "one_time" && p.currency === PRICE.currency && p.unit_amount === PRICE.unit_amount && p.tax_behavior === PRICE.tax_behavior;
const successUrl = (workerUrl) => `${workerUrl.replace(/\/+$/, "")}/success?session_id={CHECKOUT_SESSION_ID}`;

async function findProduct(stripe) {
  // default_price comes expanded so the key doesn't need Prices permissions in the usual case.
  const products = (await listAll(stripe, "/products", { active: true, expand: ["data.default_price"] })).filter(isOurs);
  if (products.length > 1) fail(`more than one active product marked ${MARK.neat_item}: ${products.map((p) => p.id).join(", ")} — archive the extras`);
  return products[0] || null;
}

async function findPrice(stripe, product) {
  const d = product.default_price;
  if (d && typeof d === "object" && priceMatches(d)) return d;
  // Only reached when the price changed (needs Prices = Read/Write on the key).
  return (await listAll(stripe, "/prices", { product: product.id, active: true })).find(priceMatches) || null;
}

/** Our active link for this price, preferring one that already redirects to `url`. */
async function findLink(stripe, priceId, url) {
  let fallback = null;
  for (const link of (await listAll(stripe, "/payment_links", { active: true })).filter(isOurs)) {
    const items = await listAll(stripe, `/payment_links/${link.id}/line_items`);
    if (items.length !== 1 || items[0].price.id !== priceId) continue;
    const ac = link.after_completion;
    if (ac && ac.type === "redirect" && ac.redirect.url === url) return link;
    fallback = fallback || link;
  }
  return fallback;
}

async function ensureProduct(stripe) {
  let product = await findProduct(stripe);
  if (!product) {
    // default_price_data creates the price with the product in one call.
    product = await stripe("POST", "/products", { ...PRODUCT, default_price_data: PRICE }, { idempotencyKey: `neat-${MARK.neat_item}-product-v1` });
    console.log(`created product ${product.id}`);
    product = await stripe("GET", `/products/${product.id}`, { expand: ["default_price"] });
  } else {
    const drift = ["name", "description", "tax_code"].filter((k) => (product[k] || null) !== PRODUCT[k]);
    if (drift.length) {
      product = await stripe("POST", `/products/${product.id}`, { name: PRODUCT.name, description: PRODUCT.description, tax_code: PRODUCT.tax_code });
      console.log(`updated product ${product.id} (${drift.join(", ")})`);
    } else console.log(`product ${product.id} already set up`);
  }
  let price = await findPrice(stripe, product);
  if (!price) {
    // Prices are immutable: a different amount means a new price, made the default.
    price = await stripe("POST", "/prices", { product: product.id, ...PRICE, metadata: MARK });
    await stripe("POST", `/products/${product.id}`, { default_price: price.id });
    console.log(`created price ${price.id}`);
  } else console.log(`price ${price.id} already set up`);
  return { product, price };
}

async function ensureLink(stripe, price, workerUrl) {
  const url = successUrl(workerUrl);
  let link = await findLink(stripe, price.id, url);
  if (link && link.after_completion.redirect && link.after_completion.redirect.url === url) {
    console.log(`payment link ${link.id} already set up`);
    return link;
  }
  if (link) {
    // New Worker address: move the redirect, keep the link (its buy.stripe.com URL is in the extension and pages).
    link = await stripe("POST", `/payment_links/${link.id}`, { after_completion: { type: "redirect", redirect: { url } } });
    console.log(`payment link ${link.id} now redirects to ${url}`);
    return link;
  }
  // Payment Links always ask for the buyer's email; the Worker reads it from the Checkout Session.
  link = await stripe(
    "POST",
    "/payment_links",
    {
      line_items: [{ price: price.id, quantity: 1 }],
      managed_payments: { enabled: true },
      after_completion: { type: "redirect", redirect: { url } },
      allow_promotion_codes: false,
      metadata: MARK,
    },
    { idempotencyKey: `neat-${MARK.neat_item}-link-${price.id}-${url}`.slice(0, 255) },
  );
  console.log(`created payment link ${link.id}`);
  return link;
}

async function readConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function saveConfig(mode, entry) {
  const config = await readConfig();
  config[mode] = { ...config[mode], ...entry };
  await mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, CONFIG_FILE)} (${mode})`);
}

async function setWranglerPrice(priceId) {
  const toml = await readFile(WRANGLER_FILE, "utf8");
  const next = toml.replace(/^STRIPE_PRICE_ID = ".*"$/m, `STRIPE_PRICE_ID = "${priceId}"`);
  if (next !== toml) {
    await writeFile(WRANGLER_FILE, next);
    console.log(`wrangler.toml STRIPE_PRICE_ID = ${priceId}`);
  }
}

function describe(product, price, link) {
  console.log(`\nproduct  ${product.id}  "${product.name}"  tax_code ${product.tax_code}  active ${product.active}`);
  const defaultId = product.default_price && (product.default_price.id || product.default_price);
  if (price) console.log(`price    ${price.id}  ${(price.unit_amount / 100).toFixed(2)} ${price.currency.toUpperCase()}  ${price.type}  tax ${price.tax_behavior}  default ${defaultId === price.id}`);
  if (link) console.log(`link     ${link.id}  ${link.url}  -> ${link.after_completion.redirect.url}  promo codes ${link.allow_promotion_codes}`);
}

async function main() {
  const args = process.argv.slice(2);
  const { key, mode } = await loadKey();
  const stripe = client(key);
  const workerUrl = (process.env.WORKER_URL || "").trim();
  if (workerUrl && !/^https:\/\/[^/\s]+(\/[^\s?#]*)?$/.test(workerUrl)) fail("WORKER_URL must be an https:// URL without query");
  console.log(`Stripe ${mode} mode`);

  if (args.includes("--check")) {
    const product = await findProduct(stripe);
    if (!product) fail("no product yet — run without --check");
    const price = await findPrice(stripe, product);
    const saved = (await readConfig())[mode] || {};
    const link = saved.payment_link_id ? await stripe("GET", `/payment_links/${saved.payment_link_id}`) : null;
    describe(product, price, link);
    return;
  }

  const { product, price } = await ensureProduct(stripe);
  await saveConfig(mode, { product_id: product.id, price_id: price.id, currency: price.currency, unit_amount: price.unit_amount, tax_behavior: price.tax_behavior, tax_code: product.tax_code });
  if (mode === "live") await setWranglerPrice(price.id);

  let link = null;
  if (workerUrl) {
    link = await ensureLink(stripe, price, workerUrl);
    await saveConfig(mode, { worker_url: workerUrl, payment_link_id: link.id, payment_link_url: link.url });
  } else console.log("no WORKER_URL: Payment Link not created (deploy the Worker first)");
  describe(product, price, link);
}

main().catch((e) => {
  console.error(e instanceof StripeSetupError ? `stripe-setup: ${e.message}` : e);
  process.exit(1);
});
