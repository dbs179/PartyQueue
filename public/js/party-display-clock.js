import { formatDisplayClock } from "./format.js";

function localTimeValue(now) {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) return "";
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * Live clock on Party Display. Ticks while the view is open.
 * @param {{
 *   el?: HTMLElement|null,
 *   now?: () => Date,
 *   intervalMs?: number,
 *   locale?: string,
 *   setIntervalFn?: typeof setInterval,
 *   clearIntervalFn?: typeof clearInterval,
 * }} [opts]
 */
export function createPartyDisplayClock(opts = {}) {
  const el = opts.el || null;
  const nowFn = opts.now || (() => new Date());
  const intervalMs = Math.max(250, Number(opts.intervalMs) || 1000);
  const locale = opts.locale;
  const setInt = opts.setIntervalFn || setInterval;
  const clearInt = opts.clearIntervalFn || clearInterval;
  /** @type {ReturnType<typeof setInterval>|null} */
  let timer = null;

  function paint() {
    if (!el) return;
    const now = nowFn();
    const text = formatDisplayClock(now, locale);
    if (el.textContent !== text) el.textContent = text;
    const stamp = localTimeValue(now);
    if (el.dateTime !== stamp) el.dateTime = stamp;
  }

  function stop() {
    if (timer == null) return;
    clearInt(timer);
    timer = null;
  }

  function start() {
    paint();
    if (timer != null) return;
    timer = setInt(() => paint(), intervalMs);
  }

  return {
    start,
    stop,
    paint,
    isRunning() {
      return timer != null;
    },
  };
}
