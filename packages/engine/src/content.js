// Content-script runtime, injected at document_start.
//
// How hiding works:
//   1. One <style> element, created before the page renders, holds
//      `display:none` for every enabled rule's css locators plus a marker
//      attribute used by text/structural locators.
//   2. A single MutationObserver (childList only) collects added nodes; at most
//      one pass per animation frame (re)evaluates text/structural matches in
//      and around just those nodes — marking new targets and unmarking nodes
//      the site has recycled for other content. Nothing runs while the page is
//      not changing.
//   3. A self-check runs in idle time (never in hidden tabs) and reports rules
//      whose targets — found by the rule's locators or by the site's
//      independent probes — are still visible.
import { BRAND_SLUG } from "../../../brand.config.js";
import { buildStylesheet } from "./css.js";
import { findTargets, isTarget, mark, unmark, selectorIsValid } from "./locators.js";
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
  // Only real HTML pages (not XML feeds, JSON, images) get a stylesheet.
  if (!(doc instanceof HTMLDocument) || doc.contentType !== "text/html") return;
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
  let navigated = false; // any in-app navigation since this document loaded

  const pending = new Set();
  let fullPassPending = false;
  let frameRequested = false;
  let observing = false;
  let checkRequested = false;
  let checkForced = false;
  let lastCheck = 0;
  const retried = new Set();
  // Rules whose primary css locator currently matches nothing on the page: only for
  // these do incremental passes also run the fallback (text/structural) locators.
  const fallbackActive = new Set();
  const reported = new Set();
  const validCache = new Map();
  const listeners = [];

  const observer = new MutationObserver(onMutations);

  const isValid = (sel) => {
    let v = validCache.get(sel);
    if (v === undefined) validCache.set(sel, (v = selectorIsValid(doc, sel)));
    return v;
  };

  /** Fire-and-forget message to the service worker; never throws, even when orphaned. */
  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => (orphaned(), undefined));
    } catch {
      orphaned();
      return Promise.resolve(undefined);
    }
  }

  const ctx = {
    doc,
    site,
    send,
    get context() {
      return site.pageContext(doc, location);
    },
    /** A feature is on when the master switch is on and its own toggle is on. */
    isOn(id, { respectAllowlist = true } = {}) {
      const f = site.features.find((x) => x.id === id);
      if (!f || !settings.enabled || dead) return false;
      if (respectAllowlist) {
        if (paused) return false;
        // Allow list in use but the page's owner isn't known yet: wait rather than act on the wrong channel.
        if (settings.allowlist.length && site.pageContext(doc, location).pending) return false;
      }
      return isOn(settings, f);
    },
  };

  function orphaned() {
    // After the extension is updated, disabled or removed, this old script is cut off.
    if (dead) return true;
    try {
      if (chrome.runtime && chrome.runtime.id) return false;
    } catch {
      /* fall through */
    }
    teardown();
    return true;
  }

  /**
   * Stop all work. The stylesheet and marks are deliberately left in place:
   * after an extension update no new script is injected into open tabs, and
   * removing the stylesheet would make Shorts reappear until the tab reloads.
   */
  function teardown() {
    dead = true;
    observer.disconnect();
    observing = false;
    pending.clear();
    for (const [target, type, fn, cap] of listeners) target.removeEventListener(type, fn, cap);
  }

  function computePaused() {
    if (!settings.allowlist.length) return false;
    return site.isAllowed(settings, site.pageContext(doc, location));
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
      // Removals inside a marked container can change whether it still matches (a recycled shelf).
      // Only those matter; YouTube removes nodes constantly elsewhere.
      if (r.removedNodes.length && r.target.nodeType === 1 && r.target.closest(`[${ATTR}]`)) pending.add(r.target);
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

  /** Drop roots that sit inside another pending root: they'd be scanned twice. */
  function outermost(set) {
    const out = [];
    for (const n of set) {
      if (!n.isConnected) continue;
      let p = n.parentNode;
      while (p && !set.has(p)) p = p.parentNode;
      if (!p) out.push(n);
    }
    return out;
  }

  function flush() {
    frameRequested = false;
    if (orphaned()) return;
    const roots = fullPassPending ? [doc] : outermost(pending);
    fullPassPending = false;
    pending.clear();
    if (pass(roots)) requestCheck();
  }

  const markedIn = (root) => (root === doc ? [...doc.querySelectorAll(`[${ATTR}]`)] : [...root.querySelectorAll(`[${ATTR}]`)]);

  /**
   * Re-evaluate text/structural matches in and around `roots`. Returns true when
   * anything was marked or unmarked. Css locators need no JS: the stylesheet
   * tracks them live.
   */
  function pass(roots) {
    if (!style.isConnected) doc.documentElement.append(style);
    const nowPaused = computePaused();
    if (nowPaused !== paused) {
      applyConfig(); // allow-list state changed (e.g. watch page owner loaded)
      return false;
    }
    if (!active) return false;
    const byId = new Map(rules.map((r) => [r.id, r]));
    const live = (el) => el.isConnected;
    let changed = false;

    // 1. Unmark elements in scope that no longer match (the site recycles nodes for new content).
    const scope = new Set();
    for (const root of roots) {
      if (root !== doc && !live(root)) continue;
      for (const el of markedIn(root)) scope.add(el);
      if (root !== doc) for (let a = root.closest(`[${ATTR}]`); a; a = a.parentElement && a.parentElement.closest(`[${ATTR}]`)) scope.add(a);
    }
    for (const el of scope) {
      for (const id of (el.getAttribute(ATTR) || "").split(" ")) {
        const rule = byId.get(id);
        const still = rule && enabled.has(id) && rule.locators.some((loc) => loc.type !== "css" && isTarget(el, loc));
        if (!still && unmark(el, ATTR, id)) changed = true;
      }
    }

    // 2. Mark new targets. Locators are tried in order: on incremental passes a
    // rule's fallbacks (text/structural after a css primary) run only while there
    // is evidence of drift — the last full pass found fallback targets although
    // the primary selector matched nothing. Full passes always run everything.
    const full = roots[0] === doc;
    for (const rule of rules) {
      if (!enabled.has(rule.id)) continue;
      const primary = rule.locators[0];
      let fallbackHits = 0;
      for (const loc of rule.locators) {
        if (loc.type === "css") continue;
        const isFallback = loc !== primary;
        if (!full && isFallback && !fallbackActive.has(rule.id)) continue;
        for (const root of roots) {
          if (root !== doc && !live(root)) continue;
          const found = findTargets(root, loc);
          if (isFallback) fallbackHits += found.length;
          for (const el of found) if (mark(el, ATTR, rule.id)) changed = true;
        }
      }
      if (full && primary.type === "css") {
        let primaryHit = false;
        try {
          primaryHit = isValid(primary.selector) && !!doc.querySelector(primary.selector);
        } catch {
          /* invalid selector: no match */
        }
        if (!primaryHit && fallbackHits > 0) fallbackActive.add(rule.id);
        else fallbackActive.delete(rule.id);
      }
    }
    for (const f of features) if (f.onPass) f.onPass(ctx);
    return changed || roots[0] === doc;
  }

  // ---- self-check -------------------------------------------------------
  function requestCheck(force = false) {
    if (dead) return;
    if (force) checkForced = true;
    if (checkRequested || doc.hidden) return; // hidden tabs: resumed on visibilitychange
    checkRequested = true;
    requestIdleCallback(runCheckWhenDue);
  }

  function runCheckWhenDue() {
    checkRequested = false;
    if (dead || doc.hidden) return;
    // Wait until marking has caught up and the last check is old enough.
    const due = checkForced || performance.now() - lastCheck >= CHECK_GAP_MS;
    if (frameRequested || pending.size || fullPassPending || !due) {
      checkRequested = true;
      requestIdleCallback(runCheckWhenDue);
      return;
    }
    checkForced = false;
    lastCheck = performance.now();
    if (!active) return;
    const opts = { probes: site.probes || {} };
    let results = selfCheck(doc, rules, enabled, opts);
    if (results.some((r) => r.broken)) {
      // Rule out a race with content that arrived between passes: re-mark everything, check again.
      pass([doc]);
      results = selfCheck(doc, rules, enabled, opts);
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

  /** A rule looks broken: fetch rules once (the service worker throttles), re-apply, re-check once. */
  async function recheckRules() {
    await send({ type: "rules:recheck" });
    if (orphaned()) return;
    try {
      const got = await chrome.storage.local.get(KEYS.rules);
      storedRules = got[KEYS.rules] || null;
    } catch {
      if (orphaned()) return;
    }
    applyConfig();
    requestCheck(true);
  }

  function report(kind, ruleId) {
    const c = site.pageContext(doc, location);
    send({ type: "diag:report", kind, ruleId, build: site.buildHint(doc), page: c.page });
  }

  /** On a fresh channel-page load, the URL handle and canonical id belong together: teach the allow list. */
  function learnAlias() {
    if (navigated || !settings.allowlist.length) return;
    const c = site.pageContext(doc, location).channel;
    if (c && c.handle && c.id && (settings.allowlist.includes(c.handle) || settings.allowlist.includes(c.id)) && settings.aliases[c.id] !== c.handle) {
      send({ type: "allow:alias", id: c.id, handle: c.handle });
    }
  }

  // ---- events -------------------------------------------------------------
  function listen(target, type, fn, cap = true) {
    target.addEventListener(type, fn, cap);
    listeners.push([target, type, fn, cap]);
  }

  function onNavigate(e) {
    if (orphaned() || !ready) return;
    if (e && e.type !== "load") navigated = true;
    applyConfig();
    requestCheck(true);
    for (const f of features) if (f.onNavigate) f.onNavigate(ctx);
  }
  for (const type of site.navigationEvents) listen(window, type, onNavigate);
  listen(window, "popstate", onNavigate);
  listen(window, "load", () => {
    if (ready && !orphaned()) learnAlias();
  });
  listen(doc, "visibilitychange", () => {
    if (!doc.hidden && checkForced && !orphaned()) requestCheck();
  });
  listen(doc, "click", (e) => {
    if (!ready || orphaned()) return;
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
  chrome.storage.local.get([KEYS.settings, KEYS.rules]).then(
    (got) => {
      if (dead) return;
      settings = normalizeSettings(got[KEYS.settings]);
      storedRules = got[KEYS.rules] || null;
      ready = true;
      applyConfig();
      for (const f of features) if (f.onReady) f.onReady(ctx);
      if (doc.readyState === "complete") learnAlias();
      // One distinct-day mark for the one-time review card (counted and capped by the service worker).
      if (settings.enabled) send({ type: "activity", day: todayKey().slice(4) });
    },
    () => orphaned(),
  );
}
