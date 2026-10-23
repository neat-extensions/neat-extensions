// MV3 service worker. Holds no state in memory that matters: every listener is
// registered synchronously at top level, and all state lives in storage, so the
// worker can be killed and restarted at any moment.
import { createUpdater } from "./updater.js";
import { KEYS, MAX_DIAGNOSTICS, normalizeSettings } from "./settings.js";

const ALARM = "rules-refresh";
const ALARM_MINUTES = 24 * 60;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

const clean = (v, max) => (typeof v === "string" ? v.replace(/[^\w.\-/:@ ]/g, "").slice(0, max) : "");

export function startBackground({ site, bundledRules, rulesUrl, masterCommand = "toggle-master" }) {
  const storage = chrome.storage.local;
  const updater = createUpdater({ site: site.id, bundled: bundledRules, rulesUrl, storage, fetchImpl: (...a) => fetch(...a) });

  // Serialises read-modify-write of diagnostics; reports from many tabs can land together.
  let diagQueue = Promise.resolve();

  async function ensureAlarm() {
    const existing = await chrome.alarms.get(ALARM);
    if (!existing) await chrome.alarms.create(ALARM, { periodInMinutes: ALARM_MINUTES, delayInMinutes: ALARM_MINUTES });
  }

  async function toggleMaster() {
    const { [KEYS.settings]: raw } = await storage.get(KEYS.settings);
    const s = normalizeSettings(raw);
    s.enabled = !s.enabled;
    await storage.set({ [KEYS.settings]: s });
  }

  function recordDiagnostic(msg) {
    const ruleId = typeof msg.ruleId === "string" && ID_RE.test(msg.ruleId) ? msg.ruleId : null;
    const kind = msg.kind === "degraded" ? "degraded" : "broken";
    if (!ruleId) return Promise.resolve();
    diagQueue = diagQueue
      .then(async () => {
        const { [KEYS.diagnostics]: list = [] } = await storage.get(KEYS.diagnostics);
        const build = clean(msg.build, 64);
        const page = clean(msg.page, 32);
        const at = new Date().toISOString();
        const same = list.find((d) => d.kind === kind && d.ruleId === ruleId && d.build === build && d.page === page);
        if (same) {
          same.at = at;
          same.count = (same.count || 1) + 1;
        } else {
          list.unshift({ kind, ruleId, build, page, at, count: 1 });
        }
        await storage.set({ [KEYS.diagnostics]: list.slice(0, MAX_DIAGNOSTICS) });
      })
      .catch(() => {});
    return diagQueue;
  }

  chrome.runtime.onInstalled.addListener(async () => {
    await ensureAlarm();
    await updater.refresh("install");
  });

  chrome.runtime.onStartup.addListener(async () => {
    await ensureAlarm();
    await updater.refresh("startup");
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) updater.refresh("alarm");
  });

  chrome.commands.onCommand.addListener((command) => {
    if (command === masterCommand) toggleMaster();
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg || typeof msg !== "object") return false;
    if (msg.type === "rules:recheck") {
      updater.refresh("recheck").then(sendResponse, () => sendResponse({ updated: false }));
      return true;
    }
    if (msg.type === "rules:refresh-now") {
      updater.refresh("manual").then(sendResponse, () => sendResponse({ updated: false }));
      return true;
    }
    if (msg.type === "diag:report") {
      recordDiagnostic(msg).then(() => sendResponse({ ok: true }));
      return true;
    }
    return false;
  });
}
