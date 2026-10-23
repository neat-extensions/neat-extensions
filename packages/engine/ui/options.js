import { ENGINE_VERSION } from "../src/version.js";
import { KEYS } from "../src/settings.js";
import { el, loadState, updateSettings, renderToggles, syncToggles } from "./toggles.js";

export async function startOptions({ site, bundledRules, moreProducts = [] }) {
  const $ = (id) => document.getElementById(id);
  let state = await loadState(site, bundledRules);

  // General + rules
  const master = $("master");
  master.addEventListener("change", () => updateSettings((s) => (s.enabled = master.checked)));
  renderToggles($("groups"), site, state.rules, state.settings, "h3");

  // Allow list
  $("allow-title").textContent = site.allowlist.title;
  $("allow-help").textContent = site.allowlist.help;
  const input = $("allow-input");
  input.placeholder = site.allowlist.placeholder;
  $("allow-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = site.normalizeChannel(input.value);
    if (!key) {
      $("allow-error").textContent = site.allowlist.invalid;
      return;
    }
    $("allow-error").textContent = "";
    await updateSettings((s) => {
      if (!s.allowlist.includes(key)) s.allowlist.push(key);
    });
    input.value = "";
  });

  function paintAllowlist() {
    const chips = $("allow-list");
    chips.replaceChildren(
      ...state.settings.allowlist.map((key) =>
        el(
          "span",
          { class: "chip" },
          el("span", { text: key }),
          el("button", {
            class: "icon-btn",
            "aria-label": `Remove ${key}`,
            text: "×",
            onclick: () =>
              updateSettings((s) => {
                s.allowlist = s.allowlist.filter((k) => k !== key);
                // forget learned id↔handle pairs for this channel too
                for (const [id, handle] of Object.entries(s.aliases)) if (id === key || handle === key) delete s.aliases[id];
              }),
          }),
        ),
      ),
    );
    if (!state.settings.allowlist.length) chips.append(el("span", { class: "muted small", text: "No channels yet." }));
  }

  // Keyboard shortcut
  const commands = await chrome.commands.getAll();
  const cmd = commands.find((c) => c.name === site.masterCommand.id);
  $("shortcut").textContent = cmd && cmd.shortcut ? cmd.shortcut : "Not set";
  $("change-shortcut").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

  // Diagnostics
  async function paintDiagnostics() {
    const got = await chrome.storage.local.get([KEYS.diagnostics, KEYS.rulesMeta]);
    const list = got[KEYS.diagnostics] || [];
    const meta = got[KEYS.rulesMeta] || {};
    $("d-version").textContent = chrome.runtime.getManifest().version;
    $("d-engine").textContent = ENGINE_VERSION;
    $("d-rules").textContent = `${state.rules.version} (${state.source})`;
    $("d-status").textContent = meta.status || "never checked";
    $("d-checked").textContent = meta.lastAttempt ? new Date(meta.lastAttempt).toLocaleString() : "—";
    const broken = list.filter((d) => d.kind === "broken");
    $("d-count").textContent = broken.length ? `${broken.length} broken rule report(s)` : "No broken rules reported.";
    $("d-log").textContent = list.length
      ? list.map((d) => `${d.at}  ${d.kind.padEnd(8)} ${d.ruleId}  page=${d.page || "?"} build=${d.build || "?"} ×${d.count || 1}`).join("\n")
      : "Nothing recorded.";
    return { list, meta };
  }
  $("d-copy").addEventListener("click", async () => {
    const { list, meta } = await paintDiagnostics();
    const text = JSON.stringify(
      { product: site.productName, version: chrome.runtime.getManifest().version, engine: ENGINE_VERSION, rules: state.rules.version, rulesSource: state.source, rulesStatus: meta.status || null, entries: list },
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(text);
      $("d-copied").textContent = "Copied.";
    } catch {
      $("d-copied").textContent = "Copy failed — select the log above instead.";
    }
  });
  $("d-clear").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "diag:clear" }); // through the worker's queue, so in-flight reports can't resurrect entries
    paintDiagnostics();
  });
  $("d-refresh").addEventListener("click", async () => {
    $("d-copied").textContent = "Checking…";
    const res = await chrome.runtime.sendMessage({ type: "rules:refresh-now" });
    $("d-copied").textContent = res && res.updated ? `Updated to ${res.version}.` : `No update (${(res && res.status) || "unknown"}).`;
    state = await loadState(site, bundledRules);
    paintDiagnostics();
  });

  // About
  const more = $("more");
  more.replaceChildren(...moreProducts.map((p) => el("li", {}, el("strong", { text: p.name }), el("span", { class: "muted", text: ` — ${p.blurb}` }))));

  function paint() {
    master.checked = state.settings.enabled;
    $("groups-wrap").classList.toggle("off", !state.settings.enabled);
    paintAllowlist();
  }
  paint();
  paintDiagnostics();
  requestAnimationFrame(() => document.body.classList.add("ready"));

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes[KEYS.settings] || changes[KEYS.rules]) {
      state = await loadState(site, bundledRules);
      syncToggles($("groups"), site, state.rules, state.settings, "h3");
      paint();
    }
    if (changes[KEYS.diagnostics] || changes[KEYS.rulesMeta] || changes[KEYS.rules]) paintDiagnostics();
  });
}
