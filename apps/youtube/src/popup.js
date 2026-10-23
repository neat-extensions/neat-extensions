import { startPopup } from "../../../packages/engine/ui/popup.js";
import site from "../site.config.js";
import bundledRules from "../rules/rules.json";

startPopup({ site, bundledRules });
