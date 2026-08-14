/**
 * PC search-bar countdown for the next automatic special set.
 */

const TITLES = {
  sameArtist: "Same Artist Set",
  requested: "Most Requested Set",
  loved: "Most Loved Set",
  hated: "Most Hated Set",
};

/**
 * @param {{ enabled?: boolean, setsUntil?: number|null }} [batch]
 */
export function sameArtistCountdownLabel(batch) {
  if (!batch?.enabled) return "";
  return specialSetCountdownLabel({
    kind: "sameArtist",
    setsUntil: batch.setsUntil,
  });
}

/**
 * @param {{ kind?: string|null, setsUntil?: number|null }} [next]
 */
export function specialSetCountdownLabel(next) {
  const title = TITLES[next?.kind];
  if (!title) return "";
  const n = Math.floor(Number(next.setsUntil));
  if (!Number.isFinite(n) || n < 0) return "";
  if (n <= 0) return `${title} In : next set`;
  if (n === 1) return `${title} In : 1 set`;
  return `${title} In : ${n} sets`;
}

/**
 * @param {{ el?: HTMLElement|null }} [opts]
 */
export function createSameArtistCountdownUi({ el } = {}) {
  function paint(next) {
    if (!el) return;
    const label = specialSetCountdownLabel(next);
    if (!label) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = label;
  }

  return { paint, sameArtistCountdownLabel, specialSetCountdownLabel };
}
