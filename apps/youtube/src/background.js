import { startBackground } from "../../../packages/engine/src/background.js";
import site from "../site.config.js";
import bundledRules from "../rules/rules.json";

// RULES_URL / RULES_FALLBACK_URL / RULES_PUBLIC_KEY are replaced at build time (scripts/build.mjs);
// they default to the site config (placeholder URL, no key = remote rules off).
startBackground({
  site,
  bundledRules,
  rulesUrl: process.env.RULES_URL || site.rulesUrl,
  fallbackUrl: process.env.RULES_FALLBACK_URL,
  publicKey: process.env.RULES_PUBLIC_KEY ? JSON.parse(process.env.RULES_PUBLIC_KEY) : site.rulesPublicKey,
  masterCommand: site.masterCommand.id,
});
