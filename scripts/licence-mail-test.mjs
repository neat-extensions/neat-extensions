// Sends one key email through the licence Worker's own mail() code, with the sender
// from wrangler.toml and the Brevo key from .secrets/brevo-api.key (never printed).
// The "key" in it is a dummy that unlocks nothing.
//   node scripts/licence-mail-test.mjs you@example.com
import { readFile } from "node:fs/promises";
import path from "node:path";
import { mail } from "../services/licence-worker/src/worker.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const to = process.argv[2];
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to || "")) {
  console.error("usage: node scripts/licence-mail-test.mjs <address>");
  process.exit(1);
}
const toml = await readFile(path.join(ROOT, "services", "licence-worker", "wrangler.toml"), "utf8");
const toml_var = (name) => (new RegExp(`^${name} = "(.*)"$`, "m").exec(toml) || [])[1];
const env = {
  MAIL_FROM: toml_var("MAIL_FROM"),
  MAIL_FROM_NAME: toml_var("MAIL_FROM_NAME"),
  BREVO_API_KEY: (await readFile(path.join(ROOT, ".secrets", "brevo-api.key"), "utf8")).trim(),
};
const ok = await mail(env, { email: to, key: "TEST-ONLY-THIS-IS-NOT-A-LICENCE-KEY" });
console.log(ok ? `✔ sent from ${env.MAIL_FROM_NAME} <${env.MAIL_FROM}> to ${to}` : "✖ Brevo refused the email");
process.exitCode = ok ? 0 : 1; // not process.exit(): it trips a libuv assertion on Windows right after fetch
