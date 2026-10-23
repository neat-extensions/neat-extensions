import { BRAND } from "../../../brand.config.js";
import { KEYS } from "../src/settings.js";
import { el, loadState, updateSettings, renderToggles, syncToggles } from "./toggles.js";

export async function startPopup({ site, bundledRules }) {
  const master = document.getElementById("master");
  const groups = document.getElementById("groups");
  const status = document.getElementById("status");
  let state = await loadState(site, bundledRules);

  function paint() {
    master.checked = state.settings.enabled;
    document.body.classList.toggle("off", !state.settings.enabled);
    status.textContent = state.settings.enabled ? "On" : "Paused";
  }

  master.addEventListener("change", () => updateSettings((s) => (s.enabled = master.checked)));
  document.getElementById("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  renderToggles(groups, site, state.rules, state.settings);
  paint();
  requestAnimationFrame(() => document.body.classList.add("ready"));

  // Show the real shortcut (the user may have changed it in chrome://extensions/shortcuts).
  const cmd = (await chrome.commands.getAll()).find((c) => c.name === site.masterCommand.id);
  master.title = cmd && cmd.shortcut ? `Shortcut: ${cmd.shortcut}` : "No keyboard shortcut set";

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local" || !(changes[KEYS.settings] || changes[KEYS.rules])) return;
    state = await loadState(site, bundledRules);
    syncToggles(groups, site, state.rules, state.settings);
    paint();
  });

  await maybeShowReviewCard();
}

/**
 * One-time, non-blocking review card. The service worker marks the user
 * eligible after enough distinct days of use; once dismissed (or the link is
 * used) it never comes back.
 */
async function maybeShowReviewCard() {
  const { [KEYS.review]: review = {} } = await chrome.storage.local.get(KEYS.review);
  if (!review.eligible || review.dismissed) return;
  const dismiss = () => {
    chrome.storage.local.set({ [KEYS.review]: { eligible: true, dismissed: true } });
    card.remove();
  };
  // This copy's own listing, wherever it was installed from.
  const reviewUrl = `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews`;
  const card = el(
    "div",
    { class: "card", id: "review-card", role: "status" },
    el(
      "div",
      {},
      el("p", { text: `Enjoying ${BRAND}? A short review helps other people find it.` }),
      el("a", { class: "btn primary", href: reviewUrl, target: "_blank", rel: "noopener noreferrer", text: "Leave a review", onclick: dismiss }),
    ),
    el("button", { class: "icon-btn", "aria-label": "Dismiss", title: "Dismiss", text: "×", onclick: dismiss }),
  );
  document.getElementById("review-slot").append(card);
}
