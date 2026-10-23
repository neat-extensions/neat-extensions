import { startBackground } from "../../../packages/engine/src/background.js";
import site from "../site.config.js";
import bundledRules from "../rules/rules.json";

// RULES_URL is replaced at build time (scripts/build.mjs); defaults to the placeholder.
startBackground({ site, bundledRules, rulesUrl: process.env.RULES_URL || site.rulesUrl, masterCommand: site.masterCommand.id });
