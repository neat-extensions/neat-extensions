// MV3 service worker. Holds no state in memory that matters: every listener is
// registered synchronously at top level, and all state lives in storage, so the
// worker can be killed and restarted at any moment. The only in-memory object
// is a promise chain that serialises read-modify-write storage updates while
// the worker happens to be alive; losing it on shutdown loses nothing.
import { createUpdater } from "./updater.js";
import { KEYS, MAX_DIAGNOSTICS, REVIEW_AFTER_DAYS, ACTIVITY_PREFIX, normalizeSettings, todayKey } from "./settings.js";

const ALARM = "rules-refresh";
const ALARM_MINUTES = 24 * 60;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const clean = (v, max) => (typeof v === "string" ? v.replace(/[^\w.\-/:@ ]/g, "").slice(0, max) : "");

export function startBackground({ site, bundledRules, rulesUrl, publicKey, masterCommand = "toggle-master" }) {
  const storage = chrome.storage.local;
  const updater = createUpdater({ site: site.id, bundled: bundledRules, rulesUrl, publicKey, storage, fetchImpl: (...a) => fetch(...a) });

  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn).catch(() => {}));

  async function ensureAlarm() {
    const existing = await chrome.alarms.get(ALARM);
    if (!existing) await chrome.alarms.create(ALARM, { periodInMinutes: ALARM_MINUTES, delayInMinutes: ALARM_MINUTES });
  }

  const toggleMaster = () =>
    serial(async () => {
      const { [KEYS.settings]: raw } = await storage.get(KEYS.settings);
      const s = normalizeSettings(raw);
      s.enabled = !s.enabled;
      await storage.set({ [KEYS.settings]: s });
    });

  const recordDiagnostic = (msg) =>
    serial(async () => {
      const ruleId = typeof msg.ruleId === "string" && ID_RE.test(msg.ruleId) ? msg.ruleId : null;
      if (!ruleId) return;
      const kind = msg.kind === "degraded" ? "degraded" : "broken";
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
    });

  const clearDiagnostics = () => serial(() => storage.set({ [KEYS.diagnostics]: [] }));

  /** One distinct-day mark per day of use; stops for good once the review card is decided. */
  const recordActivity = (day) =>
    serial(async () => {
      const all = await storage.get(null);
      const review = all[KEYS.review] || {};
      if (review.eligible || review.dismissed) return;
      const key = DAY_RE.test(day || "") ? `${ACTIVITY_PREFIX}${day}` : todayKey();
      const days = new Set(Object.keys(all).filter((k) => k.startsWith(ACTIVITY_PREFIX)));
      days.add(key);
      if (days.size >= REVIEW_AFTER_DAYS) {
        await storage.set({ [KEYS.review]: { eligible: true } });
        await storage.remove([...days].filter((k) => k in all));
      } else if (!(key in all)) {
        await storage.set({ [key]: 1 });
      }
    });

  /**
   * Redirect loop guard, kept in session storage (cleared when the browser closes,
   * invisible to web pages) because a redirect reloads the page that asked.
   * Allows at most 2 redirects of the same id per tab within 10 s.
   */
  const redirectGuard = (id, tabId) =>
    serial(async () => {
      if (typeof id !== "string" || !/^[\w-]{11}$/.test(id)) return { allow: false };
      const key = `redirect:${tabId}`;
      const now = Date.now();
      const { [key]: prev } = await chrome.storage.session.get(key);
      const n = prev && prev.id === id && now - prev.t < 10000 ? prev.n + 1 : 1;
      await chrome.storage.session.set({ [key]: { id, t: now, n } });
      return { allow: n <= 2 };
    });

  /** Remember that an allowed channel's @handle and UC… id are the same channel. */
  const learnAlias = (msg) =>
    serial(async () => {
      const id = site.normalizeChannel(msg.id || "");
      const handle = site.normalizeChannel(msg.handle || "");
      if (!id || !id.startsWith("UC") || !handle || !handle.startsWith("@")) return;
      const { [KEYS.settings]: raw } = await storage.get(KEYS.settings);
      const s = normalizeSettings(raw);
      if (!s.allowlist.includes(id) && !s.allowlist.includes(handle)) return;
      if (s.aliases[id] === handle) return;
      s.aliases[id] = handle;
      await storage.set({ [KEYS.settings]: s });
    });

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
    const reply = (p) => {
      p.then(sendResponse, () => sendResponse({ ok: false }));
      return true;
    };
    switch (msg.type) {
      case "rules:recheck":
        return reply(updater.refresh("recheck"));
      case "rules:refresh-now":
        return reply(updater.refresh("manual"));
      case "diag:report":
        return reply(recordDiagnostic(msg).then(() => ({ ok: true })));
      case "diag:clear":
        return reply(clearDiagnostics().then(() => ({ ok: true })));
      case "activity":
        return reply(recordActivity(msg.day).then(() => ({ ok: true })));
      case "redirect:guard":
        return reply(redirectGuard(msg.id, sender.tab ? sender.tab.id : -1).then((r) => r || { allow: true }));
      case "allow:alias":
        return reply(learnAlias(msg).then(() => ({ ok: true })));
      default:
        return false;
    }
  });
}
