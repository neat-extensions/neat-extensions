import { startOptions } from "../../../packages/engine/ui/options.js";
import site from "../site.config.js";
import bundledRules from "../rules/rules.json";

// Placeholder until sibling products exist. Deliberately names no other company or site.
const moreProducts = [{ name: "More tools", blurb: "in the works — small, private, one job each." }];

startOptions({ site, bundledRules, moreProducts });
