// Canary for the deployed rules: fetch RULES_URL (+ .sig) exactly as the
// extension would, verify the signature with RULES_PUBLIC_KEY and validate.
//   RULES_URL=… RULES_PUBLIC_KEY='{"kty":"EC",…}' node scripts/check-remote-rules.mjs [site]
import { parseRulesText, validateRulesUrl } from "../packages/engine/src/schema.js";
import { verifyRules } from "../packages/engine/src/signature.js";

const site = process.argv[2] || "youtube";
const url = process.env.RULES_URL;
const key = process.env.RULES_PUBLIC_KEY ? JSON.parse(process.env.RULES_PUBLIC_KEY) : null;
const fail = (m) => {
  console.error(`✖ remote rules: ${m}`);
  process.exit(1);
};
if (!url || !key) fail("RULES_URL and RULES_PUBLIC_KEY must be set");
if (!validateRulesUrl(url).ok) fail("RULES_URL must be https");
const get = async (u) => {
  const r = await fetch(u, { redirect: "error", cache: "no-store" });
  if (!r.ok) fail(`${u} → HTTP ${r.status}`);
  if (r.headers.get("access-control-allow-origin") !== "*") fail(`${u} lacks Access-Control-Allow-Origin: *`);
  return new Uint8Array(await r.arrayBuffer());
};
const [body, sig] = await Promise.all([get(url), get(`${url}.sig`)]);
if (!(await verifyRules(key, body, new TextDecoder().decode(sig)))) fail("signature does not verify");
const parsed = parseRulesText(new TextDecoder().decode(body), { site });
if (!parsed.ok) fail(parsed.errors.join("; "));
console.log(`✔ remote rules ${parsed.doc.version} for ${site}: signed, valid, ${parsed.doc.rules.length} rules`);
