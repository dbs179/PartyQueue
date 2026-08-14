/**
 * PC search-bar countdown for the next automatic same-artist set.
 */

/**
 * @param {{ enabled?: boolean, setsUntil?: number|null }} [batch]
 */
export function sameArtistCountdownLabel(batch) {
  if (!batch?.enabled) return "";
  const n = Math.floor(Number(batch.setsUntil));
  if (!Number.isFinite(n) || n < 0) return "";
  if (n <= 0) return "Same Artist Set In : next set";
  if (n === 1) return "Same Artist Set In : 1 set";
  return `Same Artist Set In : ${n} sets`;
}

/**
 * @param {{ el?: HTMLElement|null }} [opts]
 */
export function createSameArtistCountdownUi({ el } = {}) {
  function paint(batch) {
    if (!el) return;
    const label = sameArtistCountdownLabel(batch);
    if (!label) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = label;
  }

  return { paint, sameArtistCountdownLabel };
}
