// e2e builds only (scripts/build-tool.mjs --test uses this as the service worker
// entry): Playwright cannot click the toolbar button, so tests call the same
// message handlers the popup and the page bar use.
import { handlers, getState, setState } from "./background.js";

self.neatTest = { handlers, getState, setState };
