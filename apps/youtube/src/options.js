import { startOptions } from "../../../packages/engine/ui/options.js";
import site from "../site.config.js";
import bundledRules from "../rules/rules.json";

// Placeholder list until sibling products exist.
const moreProducts = [
  { name: "Reddit", blurb: "coming soon" },
  { name: "LinkedIn", blurb: "coming soon" },
  { name: "X", blurb: "coming soon" },
];

startOptions({ site, bundledRules, moreProducts });
