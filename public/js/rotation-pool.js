/** Random Mood / Random Decade pool chip paint + click wiring. */

/**
 * @param {HTMLElement|null|undefined} btn
 * @param {boolean} on
 */
export function setRotationPoolButtonOn(btn, on) {
  if (!btn) return;
  btn.classList.toggle("on", !!on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}

/**
 * @param {HTMLElement|null|undefined} container
 * @param {string} attr data attribute name (e.g. "data-pool-preset")
 * @param {string[]|null|undefined} ids selected ids
 */
export function paintRotationPool(container, attr, ids) {
  if (!container) return;
  const set = new Set(Array.isArray(ids) ? ids : []);
  for (const btn of container.querySelectorAll(`[${attr}]`)) {
    const on = set.has(btn.getAttribute(attr));
    setRotationPoolButtonOn(btn, on);
  }
}

/**
 * @param {HTMLElement|null|undefined} container
 * @param {string} attr
 * @returns {string[]}
 */
export function readRotationPoolIds(container, attr) {
  if (!container) return [];
  return [...container.querySelectorAll(`[${attr}].on`)].map((b) =>
    b.getAttribute(attr)
  );
}

/**
 * Toggle chips on click; call `onIdsChange(ids)` with the new selection.
 *
 * @param {HTMLElement|null|undefined} container
 * @param {string} attr
 * @param {(ids: string[]) => void} onIdsChange
 */
export function wireRotationPool(container, attr, onIdsChange) {
  if (!container || typeof onIdsChange !== "function") return;
  container.addEventListener("click", (e) => {
    const btn = e.target.closest(`[${attr}]`);
    if (!btn) return;
    const on = !btn.classList.contains("on");
    setRotationPoolButtonOn(btn, on);
    onIdsChange(readRotationPoolIds(container, attr));
  });
}
