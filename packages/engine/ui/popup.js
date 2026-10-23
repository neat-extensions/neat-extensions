import { BRAND } from "../../../brand.config.js";
import { KEYS, REVIEW_AFTER_DAYS, ACTIVITY_PREFIX, countActivityDays } from "../src/settings.js";
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

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local" || !(changes[KEYS.settings] || changes[KEYS.rules])) return;
    state = await loadState(site, bundledRules);
    syncToggles(groups, site, state.rules, state.settings);
    paint();
  });

  await maybeShowReviewCard(site);
}

/** One-time, non-blocking review card after REVIEW_AFTER_DAYS distinct days of use. */
async function maybeShowReviewCard(site) {
  const all = await chrome.storage.local.get(null);
  const review = all[KEYS.review] || {};
  if (review.dismissed) return;
  if (!review.eligible) {
    if (countActivityDays(all) < REVIEW_AFTER_DAYS) return;
    // Eligible now: remember that and drop the day counters, they are no longer needed.
    await chrome.storage.local.set({ [KEYS.review]: { eligible: true } });
    await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith(ACTIVITY_PREFIX)));
  }
  const dismiss = () => {
    chrome.storage.local.set({ [KEYS.review]: { eligible: true, dismissed: true } });
    card.remove();
  };
  const card = el(
    "div",
    { class: "card", id: "review-card", role: "status" },
    el(
      "div",
      {},
      el("p", { text: `Enjoying ${BRAND}? A short review helps other people find it.` }),
      el("a", { class: "btn primary", href: site.reviewUrl, target: "_blank", rel: "noopener noreferrer", text: "Leave a review", onclick: dismiss }),
    ),
    el("button", { class: "icon-btn", "aria-label": "Dismiss", title: "Dismiss", text: "×", onclick: dismiss }),
  );
  document.getElementById("review-slot").append(card);
}
