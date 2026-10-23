// Content-script runtime, injected at document_start.
//
// How hiding works:
//   1. One <style> element, created before the page renders, holds
//      `display:none` for every enabled rule's css locators plus a marker
//      attribute used by text/structural locators.
//   2. A single MutationObserver (childList only) collects added nodes; at most
//      one pass per animation frame marks text/structural matches inside just
//      those nodes. Nothing runs while the page is not changing.
//   3. A self-check runs in idle time and reports rules whose targets are
//      still visible.
import { BRAND_SLUG } from "../../../brand.config.js";
import { buildStylesheet } from "./css.js";
import { findTargets, mark, clearMarks, selectorIsValid } from "./locators.js";
import { selfCheck } from "./selfcheck.js";
import { KEYS, normalizeSettings, isOn, pickRules, todayKey } from "./settings.js";

const ATTR = `data-${BRAND_SLUG}-hide`;
const MAX_PENDING = 300; // beyond this, one full-document pass is cheaper than many small ones
const CHECK_GAP_MS = 3000; // minimum spacing between self-checks

/**
 * @param {{site: object, bundledRules: object, features?: Array<object>}} opts
 *   features: site behaviours that are not hiding (e.g. redirects). Each may
 *   implement onReady(ctx), onNavigate(ctx), onPass(ctx), onClick(event, ctx).
 */
export function startContent({ site, bundledRules, features = [] }) {
  const doc = document;
  const style = doc.createElement("style");
  style.setAttribute(`data-${BRAND_SLUG}`, "");
  doc.documentElement.append(style);

  let settings = normalizeSettings(null);
  let storedRules = null;
  let rules = bundledRules.rules;
  let enabled = new Set();
  let active = false; // master on and this page not allow-listed
  let paused = false; // allow-listed channel
  let ready = false;
  let dead = false;

  const pending = new Set();
  let fullPassPending = false;
  let frameRequested = false;
  let observing = false;
  let checkRequested = false;
  let lastCheck = 0;
  const retried = new Set();
  const reported = new Set();
  const validCache = new Map();
  const listeners = [];

  const observer = new MutationObserver(onMutations);

  const isValid = (sel) => {
    let v = validCache.get(sel);
    if (v === undefined) validCache.set(sel, (v = selectorIsValid(doc, sel)));
    return v;
  };

  const ctx = {
    doc,
    site,
    get context() {
      return site.pageContext(doc, location);
    },
    /** A feature is on when the master switch is on and its own toggle is on. */
    isOn(id, { respectAllowlist = true } = {}) {
      const f = site.features.find((x) => x.id === id);
      if (!f || !settings.enabled || dead) return false;
      if (respectAllowlist && paused) return false;
      return isOn(settings, f);
    },
  };

  function orphaned() {
    // After the extension is updated, disabled or removed, this old script is cut off.
    if (dead) return true;
    if (globalThis.chrome && chrome.runtime && chrome.runtime.id) return false;
    teardown();
    return true;
  }

  function teardown() {
    dead = true;
    observer.disconnect();
    observing = false;
    pending.clear();
    style.remove();
    clearMarks(doc, ATTR);
    for (const [target, type, fn, cap] of listeners) target.removeEventListener(type, fn, cap);
  }

  function computePaused() {
    if (!settings.allowlist.length) return false;
    return site.isAllowed(settings.allowlist, site.pageContext(doc, location));
  }

  function applyConfig() {
    if (dead) return;
    const picked = pickRules(bundledRules, storedRules, site.id);
    rules = picked.doc.rules;
    enabled = new Set(rules.filter((r) => isOn(settings, r)).map((r) => r.id));
    paused = computePaused();
    active = settings.enabled && !paused;
    const css = active ? buildStylesheet(rules, enabled, ATTR, isValid) : "";
    if (style.textContent !== css) style.textContent = css;
    if (settings.enabled && !observing) {
      observer.observe(doc.documentElement, { childList: true, subtree: true });
      observing = true;
    } else if (!settings.enabled && observing) {
      observer.disconnect();
      observing = false;
      pending.clear();
    }
    if (active) {
      fullPassPending = true;
      requestFrame();
    }
  }

  function onMutations(records) {
    if (fullPassPending) return requestFrame();
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n === style) continue;
        if (n.nodeType === 1) pending.add(n);
        else if (n.nodeType === 3 && r.target.nodeType === 1) pending.add(r.target);
      }
      if (pending.size > MAX_PENDING) {
        // Background tabs get no animation frames: never let this grow unbounded.
        pending.clear();
        fullPassPending = true;
        break;
      }
    }
    if (pending.size || fullPassPending) requestFrame();
  }

  function requestFrame() {
    if (frameRequested || dead) return;
    frameRequested = true;
    requestAnimationFrame(flush);
  }

  function flush() {
    frameRequested = false;
    if (orphaned()) return;
    const roots = fullPassPending ? [doc] : [...pending];
    fullPassPending = false;
    pending.clear();
    pass(roots);
  }

  function pass(roots) {
    if (!style.isConnected) doc.documentElement.append(style);
    const nowPaused = computePaused();
    if (nowPaused !== paused) return applyConfig(); // allow-list state changed (e.g. watch page owner loaded)
    if (!active) return;
    let changed = false;
    for (const rule of rules) {
      if (!enabled.has(rule.id)) continue;
      for (const loc of rule.locators) {
        if (loc.type === "css") continue; // the stylesheet handles these with no JS at all
        for (const root of roots) {
          if (root !== doc && !root.isConnected) continue;
          for (const el of findTargets(root, loc)) if (mark(el, ATTR, rule.id)) changed = true;
        }
      }
    }
    for (const f of features) if (f.onPass) f.onPass(ctx);
    if (changed || roots[0] === doc) requestCheck();
  }

  // ---- self-check -------------------------------------------------------
  function requestCheck() {
    if (checkRequested || dead) return;
    checkRequested = true;
    requestIdleCallback(runCheckWhenDue);
  }

  function runCheckWhenDue() {
    if (dead) return;
    // Wait until marking has caught up and the last check is old enough.
    if (frameRequested || pending.size || fullPassPending || performance.now() - lastCheck < CHECK_GAP_MS) {
      requestIdleCallback(runCheckWhenDue);
      return;
    }
    checkRequested = false;
    lastCheck = performance.now();
    if (!active) return;
    let results = selfCheck(doc, rules, enabled);
    if (results.some((r) => r.broken)) {
      // Rule out a race with content that arrived between passes: mark everything, check again.
      pass([doc]);
      results = selfCheck(doc, rules, enabled);
    }
    for (const r of results) {
      if (r.degraded && !reported.has(`d:${r.id}`)) {
        reported.add(`d:${r.id}`);
        report("degraded", r.id);
      }
      if (!r.broken) continue;
      if (!retried.has(r.id)) {
        retried.add(r.id);
        recheckRules();
      } else if (!reported.has(`b:${r.id}`)) {
        reported.add(`b:${r.id}`);
        report("broken", r.id);
      }
    }
  }

  async function recheckRules() {
    try {
      await chrome.runtime.sendMessage({ type: "rules:recheck" });
      const got = await chrome.storage.local.get(KEYS.rules);
      storedRules = got[KEYS.rules] || null;
    } catch {
      if (orphaned()) return;
    }
    applyConfig();
    lastCheck = 0; // the retry check may run straight away
    requestCheck();
  }

  function report(kind, ruleId) {
    const c = site.pageContext(doc, location);
    chrome.runtime
      .sendMessage({ type: "diag:report", kind, ruleId, build: site.buildHint(doc), page: c.page })
      .catch(() => orphaned());
  }

  // ---- events -------------------------------------------------------------
  function listen(target, type, fn, cap = true) {
    target.addEventListener(type, fn, cap);
    listeners.push([target, type, fn, cap]);
  }

  function onNavigate() {
    if (orphaned() || !ready) return;
    applyConfig();
    for (const f of features) if (f.onNavigate) f.onNavigate(ctx);
  }
  for (const type of site.navigationEvents) listen(window, type, onNavigate);
  listen(window, "popstate", onNavigate);
  listen(doc, "click", (e) => {
    if (!ready || dead) return;
    for (const f of features) if (f.onClick) f.onClick(e, ctx);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || orphaned()) return;
    if (changes[KEYS.settings]) settings = normalizeSettings(changes[KEYS.settings].newValue);
    if (changes[KEYS.rules]) storedRules = changes[KEYS.rules].newValue || null;
    if (changes[KEYS.settings] || changes[KEYS.rules]) {
      applyConfig();
      for (const f of features) if (f.onNavigate) f.onNavigate(ctx);
    }
  });

  // ---- start --------------------------------------------------------------
  const dayKey = todayKey();
  chrome.storage.local.get([KEYS.settings, KEYS.rules, KEYS.review, dayKey]).then((got) => {
    if (dead) return;
    settings = normalizeSettings(got[KEYS.settings]);
    storedRules = got[KEYS.rules] || null;
    ready = true;
    applyConfig();
    for (const f of features) if (f.onReady) f.onReady(ctx);
    // Count distinct days of use for the one-time review card; stop once it is decided.
    const review = got[KEYS.review] || {};
    if (settings.enabled && !got[dayKey] && !review.eligible && !review.dismissed) {
      chrome.storage.local.set({ [dayKey]: 1 }).catch(() => {});
    }
  }, () => orphaned());
}
