// Shared UI helpers for popup and options. DOM is built with createElement and
// textContent only — never innerHTML — so no rule text can become markup.
import { KEYS, normalizeSettings, isOn, pickRules } from "../src/settings.js";

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

export async function loadState(site, bundledRules) {
  const got = await chrome.storage.local.get([KEYS.settings, KEYS.rules]);
  const settings = normalizeSettings(got[KEYS.settings]);
  const { doc, source } = pickRules(bundledRules, got[KEYS.rules], site.id);
  return { settings, rules: doc, source };
}

/** Read-modify-write the settings object (fresh read, so popup and options don't clobber each other). */
export async function updateSettings(mutator) {
  const got = await chrome.storage.local.get(KEYS.settings);
  const s = normalizeSettings(got[KEYS.settings]);
  mutator(s);
  await chrome.storage.local.set({ [KEYS.settings]: s });
  return s;
}

/** Rules and features grouped in the site's preferred order. */
export function groupedItems(site, rulesDoc) {
  const items = [...rulesDoc.rules.map((r) => ({ ...r, kind: "rule" })), ...site.features.map((f) => ({ ...f, kind: "feature" }))];
  const order = [...site.groups];
  for (const it of items) if (!order.includes(it.group)) order.push(it.group);
  return order
    .map((g) => ({ group: g, items: items.filter((i) => i.group === g) }))
    .filter((g) => g.items.length);
}

/** Render grouped toggles into `container`. */
export function renderToggles(container, site, rulesDoc, settings, headingLevel = "h2") {
  container.replaceChildren();
  for (const { group, items } of groupedItems(site, rulesDoc)) {
    const list = el("div", { class: "list" });
    for (const item of items) {
      const input = el("input", {
        type: "checkbox",
        role: "switch",
        class: "switch",
        "data-id": item.id,
        id: `t-${item.id}`,
      });
      input.checked = isOn(settings, item);
      input.addEventListener("change", () =>
        updateSettings((s) => {
          s.toggles[item.id] = input.checked;
        }),
      );
      list.append(el("label", { class: "row", for: `t-${item.id}` }, el("span", { text: item.label }), input));
    }
    container.append(el("div", { class: "group" }, el(headingLevel, { text: group }), list));
  }
}

/** Re-sync checkbox states without rebuilding (keeps focus while a user is tabbing). */
export function syncToggles(container, site, rulesDoc, settings, headingLevel = "h2") {
  const known = new Set([...rulesDoc.rules, ...site.features].map((i) => i.id));
  const shown = new Set([...container.querySelectorAll("input[data-id]")].map((i) => i.dataset.id));
  if (known.size !== shown.size || [...known].some((id) => !shown.has(id))) return renderToggles(container, site, rulesDoc, settings, headingLevel);
  for (const item of [...rulesDoc.rules, ...site.features]) {
    const input = container.querySelector(`input[data-id="${CSS.escape(item.id)}"]`);
    if (input) input.checked = isOn(settings, item);
  }
}
