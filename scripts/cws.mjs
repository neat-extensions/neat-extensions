// Chrome Web Store API v2 client: status / upload / publish without the dashboard form.
//
//   node scripts/cws.mjs auth                       one-time: prints a consent URL, catches the code on 127.0.0.1
//   node scripts/cws.mjs auth --code <code|url>     ...or exchange a code pasted from the browser's address bar
//   node scripts/cws.mjs status  <itemId>
//   node scripts/cws.mjs upload  <itemId> <zip>     uploads a new package to the existing item (does not publish)
//   node scripts/cws.mjs publish <itemId> --publish submits for review; refuses without --publish
//
// Credentials live only in .secrets/ (git-ignored): cws-client.json {client_id, client_secret, publisher_id}
// and cws-token.json {refresh_token}. Nothing secret is ever printed.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SECRETS = path.join(ROOT, ".secrets");
const CLIENT_FILE = path.join(SECRETS, "cws-client.json");
const TOKEN_FILE = path.join(SECRETS, "cws-token.json");
const PENDING_FILE = path.join(SECRETS, "cws-auth-pending.json");
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";
const API = "https://chromewebstore.googleapis.com";
const ITEM_ID_RE = /^[a-p]{32}$/;

export class CwsError extends Error {}
const fail = (m) => {
  throw new CwsError(m);
};

async function readJson(file, what) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fail(`${what} missing (${path.relative(ROOT, file)}) — see README "Chrome Web Store API"`);
  }
}

async function client({ needPublisher = true } = {}) {
  const c = await readJson(CLIENT_FILE, "OAuth client");
  if (!c.client_id || !c.client_secret) fail("cws-client.json needs client_id and client_secret");
  if (needPublisher && !c.publisher_id) fail("cws-client.json needs publisher_id (Developer Dashboard → Settings, or the dashboard URL)");
  return c;
}

/** POST to Google's token endpoint. Errors carry only Google's error code, never request values. */
async function token(params) {
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(`token endpoint: ${body.error || res.status}${body.error_description ? ` (${body.error_description})` : ""}`);
  return body;
}

async function accessToken() {
  const c = await client({ needPublisher: false });
  const t = await readJson(TOKEN_FILE, "refresh token (run: npm run cws -- auth)");
  const r = await token({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: t.refresh_token, grant_type: "refresh_token" });
  return { c, at: r.access_token };
}

async function api(method, url, { body, headers = {} } = {}) {
  const { at } = await accessToken();
  const res = await fetch(url, { method, headers: { authorization: `Bearer ${at}`, ...headers }, body });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  if (!res.ok) fail(`${method} ${url.replace(API, "")} → HTTP ${res.status}: ${json.error?.message || json.raw || ""}`);
  return json;
}

const itemUrl = (c, id, verb) => `${API}/v2/publishers/${c.publisher_id}/items/${id}:${verb}`;
function checkId(id) {
  if (!ITEM_ID_RE.test(id || "")) fail(`item id must be the 32-letter extension id (a–p), got "${id || ""}"`);
}

export async function status(id) {
  checkId(id);
  const c = await client();
  return api("GET", itemUrl(c, id, "fetchStatus"));
}

export async function upload(id, zip) {
  checkId(id);
  const c = await client();
  const bytes = await readFile(zip).catch(() => fail(`cannot read ${zip}`));
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) fail(`${zip} is not a zip file`);
  const r = await api("POST", `${API}/upload/v2/publishers/${c.publisher_id}/items/${id}:upload`, { body: bytes, headers: { "content-type": "application/zip" } });
  return r;
}

/** Submits the uploaded draft for review. `confirmed` must be the literal --publish flag from the caller. */
export async function publish(id, { confirmed } = {}) {
  if (confirmed !== true) fail("refusing to publish without --publish");
  checkId(id);
  const c = await client();
  return api("POST", itemUrl(c, id, "publish"), { body: JSON.stringify({}), headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------- one-time authorisation
const b64url = (b) => b.toString("base64url");

async function exchange(code, pending) {
  const c = await client({ needPublisher: false });
  const r = await token({ client_id: c.client_id, client_secret: c.client_secret, code, code_verifier: pending.verifier, redirect_uri: pending.redirect, grant_type: "authorization_code" });
  if (!r.refresh_token) fail("Google returned no refresh token — revoke the app at https://myaccount.google.com/permissions and run auth again");
  await writeFile(TOKEN_FILE, JSON.stringify({ refresh_token: r.refresh_token, scope: r.scope, created: new Date().toISOString() }), { mode: 0o600 });
  await rm(PENDING_FILE, { force: true });
  console.log(`✔ refresh token stored in ${path.relative(ROOT, TOKEN_FILE)} (scope: ${r.scope})`);
}

async function auth(args) {
  const c = await client({ needPublisher: false });
  await mkdir(SECRETS, { recursive: true });
  const pasted = args[args.indexOf("--code") + 1];
  if (args.includes("--code")) {
    const pending = await readJson(PENDING_FILE, "pending authorisation (run auth without --code first)");
    let code = pasted || "";
    if (/^https?:/.test(code)) {
      const u = new URL(code);
      if (u.searchParams.get("state") !== pending.state) fail("state mismatch — use the URL from the latest auth run");
      code = u.searchParams.get("code") || "";
    }
    if (!code) fail("no code given");
    return exchange(code, pending);
  }
  // Loopback redirect (Desktop app client) + PKCE + state.
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const redirect = `http://127.0.0.1:${server.address().port}/`;
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const pending = { redirect, verifier, state, created: Date.now() };
  await writeFile(PENDING_FILE, JSON.stringify(pending), { mode: 0o600 });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: c.client_id,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state,
  }).toString();
  console.log(`Open this URL, sign in as the store account and click Allow:\n\n${url}\n\nWaiting on ${redirect} (Ctrl+C to stop; or paste the final address-bar URL into: npm run cws -- auth --code "<url>")`);
  await new Promise((resolve, reject) => {
    server.on("request", async (req, res) => {
      const u = new URL(req.url, redirect);
      const code = u.searchParams.get("code");
      if (!code && !u.searchParams.get("error")) return res.writeHead(404).end();
      try {
        if (u.searchParams.get("error")) fail(`consent refused: ${u.searchParams.get("error")}`);
        if (u.searchParams.get("state") !== state) fail("state mismatch");
        await exchange(code, pending);
        res.writeHead(200, { "content-type": "text/plain" }).end("Authorised. You can close this tab.");
        resolve();
      } catch (e) {
        res.writeHead(400, { "content-type": "text/plain" }).end("Authorisation failed — see the terminal.");
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

// ---------------------------------------------------------------- CLI
function show(r) {
  console.log(JSON.stringify(r, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const [cmd, ...rest] = process.argv.slice(2);
  const pos = rest.filter((a) => !a.startsWith("--"));
  try {
    if (cmd === "auth") await auth(rest);
    else if (cmd === "status") show(await status(pos[0]));
    else if (cmd === "upload") {
      if (!pos[1]) fail("usage: cws.mjs upload <itemId> <zip>");
      console.log(`uploading ${pos[1]} (${(await stat(pos[1])).size} bytes) — this does NOT publish`);
      show(await upload(pos[0], pos[1]));
    } else if (cmd === "publish") show(await publish(pos[0], { confirmed: rest.includes("--publish") }));
    else {
      console.log("usage: cws.mjs auth [--code <code|url>] | status <itemId> | upload <itemId> <zip> | publish <itemId> --publish");
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`✖ cws: ${e instanceof CwsError ? e.message : e.message || e}`);
    process.exitCode = 1;
  }
}
