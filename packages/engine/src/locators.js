// Locator evaluation. Three locator kinds, tried in order for every rule:
//   css        — a selector; hidden directly by the injected stylesheet.
//   text       — the nearest `container` that holds a `label` element whose text equals `match`.
//   structural — start from an `anchor` element and climb to its nearest `container`.
// text/structural matches are marked with an attribute that the same stylesheet hides.

const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

/** querySelectorAll that also considers `root` itself, and never throws on a bad selector. */
export function qsaIncl(root, selector) {
  try {
    const out = [];
    if (root.nodeType === 1 && root.matches(selector)) out.push(root);
    for (const el of root.querySelectorAll(selector)) out.push(el);
    return out;
  } catch {
    return [];
  }
}

function closestSafe(el, selector) {
  try {
    return el.closest(selector);
  } catch {
    return null;
  }
}

function textMatches(container, loc) {
  const want = norm(loc.match);
  for (const label of qsaIncl(container, loc.label)) {
    if (norm(label.textContent) === want) return true;
  }
  return false;
}

/**
 * Elements targeted by one locator inside `root` (a Document or Element).
 * For an Element root this is incremental: it also finds the container that
 * encloses `root`, so content streamed into an existing shelf is caught.
 */
export function findTargets(root, loc) {
  const isEl = root.nodeType === 1;
  if (loc.type === "css") return qsaIncl(root, loc.selector);
  const found = new Set();
  if (loc.type === "text") {
    const candidates = qsaIncl(root, loc.container);
    if (isEl) {
      const up = closestSafe(root, loc.container);
      if (up) candidates.push(up);
    }
    for (const c of candidates) if (textMatches(c, loc)) found.add(c);
  } else if (loc.type === "structural") {
    for (const a of qsaIncl(root, loc.anchor)) {
      const c = closestSafe(a, loc.container);
      if (c) found.add(c);
    }
    if (isEl) {
      // root may be inside the anchor (e.g. a thumbnail streamed into a link).
      const a = closestSafe(root, loc.anchor);
      const c = a && closestSafe(a, loc.container);
      if (c) found.add(c);
    }
  }
  return [...found];
}

function matchesSafe(el, selector) {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

/** Does `el` (still) qualify as a target of this locator? Used to drop stale marks. */
export function isTarget(el, loc) {
  if (loc.type === "css") return matchesSafe(el, loc.selector);
  if (!matchesSafe(el, loc.container)) return false;
  if (loc.type === "text") return textMatches(el, loc);
  if (loc.type === "structural") return qsaIncl(el, loc.anchor).some((a) => closestSafe(a, loc.container) === el);
  return false;
}

/** True if a selector parses in this browser. */
export function selectorIsValid(doc, selector) {
  try {
    doc.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

/** Add `id` to the space-separated marker attribute. Returns true if it changed. */
export function mark(el, attr, id) {
  const cur = el.getAttribute(attr);
  if (cur === null) {
    el.setAttribute(attr, id);
    return true;
  }
  const tokens = cur.split(" ");
  if (tokens.includes(id)) return false;
  tokens.push(id);
  el.setAttribute(attr, tokens.join(" "));
  return true;
}

/** Remove `id` from the marker attribute. Returns true if it changed. */
export function unmark(el, attr, id) {
  const cur = el.getAttribute(attr);
  if (cur === null) return false;
  const tokens = cur.split(" ").filter((t) => t && t !== id);
  if (tokens.length === cur.split(" ").length) return false;
  if (tokens.length) el.setAttribute(attr, tokens.join(" "));
  else el.removeAttribute(attr);
  return true;
}

/** Remove every marker attribute. */
export function clearMarks(doc, attr) {
  for (const el of doc.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
}
