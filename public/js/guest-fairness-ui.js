/** Guest search-bar line: remaining song + Set Request fairness. */

/**
 * @param {number|null|undefined} retryAt
 * @param {number} [now]
 */
export function retryMinutesLabel(retryAt, now = Date.now()) {
  const at = Number(retryAt);
  if (!Number.isFinite(at) || at <= now) return 1;
  return Math.max(1, Math.ceil((at - now) / 60_000));
}

/**
 * Short status copy for the search sticky bar.
 * @param {object|null|undefined} status
 * @param {{ now?: number }} [opts]
 */
export function guestFairnessLabel(status, opts = {}) {
  if (!status?.active) return "";
  const now = opts.now ?? Date.now();
  const parts = [];

  const song = status.song;
  if (song?.enabled) {
    if (song.needsName) {
      parts.push("Songs: set your name");
    } else if (
      song.upcomingActive &&
      Number(song.upcomingRemaining) <= 0
    ) {
      parts.push("Songs: wait for one of yours");
    } else if (Number(song.rollingRemaining) <= 0) {
      const mins = retryMinutesLabel(song.retryAt, now);
      parts.push(`Songs: wait ~${mins}m`);
    } else {
      const left = Number(song.rollingRemaining);
      parts.push(`Songs: ${left} left`);
    }
  }

  const set = status.setRequest;
  if (set?.enabled) {
    if (set.needsName) {
      parts.push("Sets: set your name");
    } else if (Number(set.rollingRemaining) <= 0) {
      const mins = retryMinutesLabel(set.retryAt, now);
      parts.push(`Sets: wait ~${mins}m`);
    } else {
      const left = Number(set.rollingRemaining);
      parts.push(`Sets: ${left} left`);
    }
  }

  return parts.join(" · ");
}

/**
 * @param {{
 *   el?: HTMLElement|null,
 *   getUser?: () => string,
 *   fetchImpl?: typeof fetch,
 * }} opts
 */
export function createGuestFairnessUi({
  el,
  getUser = () => "",
  fetchImpl = fetch,
} = {}) {
  let lastLabel = "";
  let inFlight = null;

  function paint(status) {
    if (!el) return;
    const label = guestFairnessLabel(status);
    lastLabel = label;
    if (!label) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = label;
  }

  async function refresh() {
    if (!el) return null;
    const user = String(getUser() || "").trim();
    const run = (async () => {
      try {
        const qs = user ? `?user=${encodeURIComponent(user)}` : "";
        const res = await fetchImpl(`/api/fairness${qs}`);
        if (!res.ok) {
          paint(null);
          return null;
        }
        const status = await res.json();
        paint(status);
        return status;
      } catch {
        // Keep the last good line if the network blips.
        if (!lastLabel && el) {
          el.hidden = true;
          el.textContent = "";
        }
        return null;
      }
    })();
    inFlight = run;
    try {
      return await run;
    } finally {
      if (inFlight === run) inFlight = null;
    }
  }

  return { refresh, paint, guestFairnessLabel };
}
