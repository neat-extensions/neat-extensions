import { startContent } from "../../../packages/engine/src/content.js";
import site from "../site.config.js";
import bundledRules from "../rules/rules.json";
import features from "./features.js";

startContent({ site, bundledRules, features });
