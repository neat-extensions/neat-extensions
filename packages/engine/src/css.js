// Builds the single stylesheet the engine injects. Only `display: none` is ever
// emitted, and only for selectors that passed the schema validator.

/**
 * @param {Array} rules           validated rules
 * @param {Set<string>} enabled   ids of rules that are on
 * @param {string} attr           marker attribute for text/structural matches
 * @param {(sel: string) => boolean} [isValid]  browser-side selector check
 */
export function buildStylesheet(rules, enabled, attr, isValid = () => true) {
  const lines = [];
  for (const rule of rules) {
    if (!enabled.has(rule.id)) continue;
    const sels = [];
    for (const loc of rule.locators) {
      if (loc.type === "css" && isValid(loc.selector)) sels.push(loc.selector);
    }
    // One block per rule so a selector this browser rejects can't disable the others.
    for (const sel of sels) lines.push(`${sel} { display: none !important; }`);
    lines.push(`[${attr}~="${rule.id}"] { display: none !important; }`);
  }
  return lines.join("\n");
}
