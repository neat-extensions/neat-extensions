// The free plan's time limit. Counts recorded time only (paused time is not
// recorded). `timeScale` exists for tests: the e2e build sets it so that the
// 10-minute limit passes in seconds; release builds are checked to use 1.

export function createLimiter({ limitMs, timeScale = 1, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout, onLimit }) {
  let startedAt = null; // when the current running stretch began
  let banked = 0; // recorded ms before the current stretch
  let timer = null;
  let fired = false;

  const elapsed = () => (banked + (startedAt === null ? 0 : now() - startedAt)) * timeScale;

  function arm() {
    if (limitMs === Infinity || fired) return;
    const left = Math.max(0, (limitMs - elapsed()) / timeScale);
    timer = setTimer(() => {
      timer = null;
      if (elapsed() + 1 >= limitMs) {
        fired = true;
        banked += now() - startedAt;
        startedAt = null;
        onLimit();
      } else arm();
    }, left);
  }

  return {
    start() {
      startedAt = now();
      arm();
    },
    pause() {
      if (startedAt === null) return;
      banked += now() - startedAt;
      startedAt = null;
      if (timer) clearTimer(timer);
      timer = null;
    },
    resume() {
      if (startedAt !== null || fired) return;
      startedAt = now();
      arm();
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
      if (startedAt !== null) banked += now() - startedAt;
      startedAt = null;
    },
    /** recorded time in (scaled) ms */
    elapsed,
    get hitLimit() {
      return fired;
    },
  };
}

/** The quiet "Saved. Pro removes the 10-minute limit" line: at most once per calendar day. */
export function shouldShowLimitNote(lastShownDay, today) {
  return lastShownDay !== today;
}

export function dayKey(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
