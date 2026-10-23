// Self-check: after rules are applied, every target of an enabled rule must be
// invisible. A rule whose locators still find visible elements is "broken".
// A rule whose primary (first) locator finds nothing while a fallback does is
// "degraded" — still working, but the primary selector has drifted.
import { findTargets } from "./locators.js";

/**
 * Visible = rendered, not hidden by CSS, and with a real box. Zero-size elements
 * (empty placeholders, collapsed containers) are deliberately NOT visible, so
 * they never cause a false "broken" report. `display: contents` boxes have no
 * rect of their own, so they count as visible only if a child is.
 */
export function isVisible(el, depth = 0) {
  if (!el.isConnected) return false;
  // checkVisibility() is false for display:contents (no box of its own), so look at children first.
  if (el.ownerDocument.defaultView.getComputedStyle(el).display === "contents") {
    if (depth >= 3) return false;
    for (const child of el.children) if (isVisible(child, depth + 1)) return true;
    return false;
  }
  if (typeof el.checkVisibility === "function" && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
    return false;
  const r = el.getBoundingClientRect();
  return r.width >= 1 && r.height >= 1;
}

/**
 * @param {Document|Element} root
 * @param {Array} rules
 * @param {Set<string>} enabled
 * @returns {Array<{id: string, matched: number, visible: number, broken: boolean, degraded: boolean}>}
 */
export function selfCheck(root, rules, enabled, visible = isVisible) {
  const out = [];
  for (const rule of rules) {
    if (!enabled.has(rule.id)) continue;
    const all = new Set();
    let primary = 0;
    rule.locators.forEach((loc, i) => {
      const t = findTargets(root, loc);
      if (i === 0) primary = t.length;
      for (const el of t) all.add(el);
    });
    let vis = 0;
    for (const el of all) if (visible(el)) vis++;
    out.push({ id: rule.id, matched: all.size, visible: vis, broken: vis > 0, degraded: primary === 0 && all.size > 0 });
  }
  return out;
}
