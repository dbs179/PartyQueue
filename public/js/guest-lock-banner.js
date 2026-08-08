/** Guest-facing Requests paused / Party's Over banner copy + paint. */

export const GUEST_BANNER_PAUSED =
  "Requests are paused — ask the host when you can add songs again.";

export const GUEST_BANNER_PARTY_OVER =
  "The party is over — you have to go home now.";

/**
 * Party's Over wins over a plain request pause when both are set.
 *
 * @param {{ partyOver?: boolean, requestsPaused?: boolean }} flags
 * @returns {{ hidden: boolean, text: string, partyOver: boolean }}
 */
export function guestLockBannerView({
  partyOver = false,
  requestsPaused = false,
} = {}) {
  const over = !!partyOver;
  const locked = over || !!requestsPaused;
  return {
    hidden: !locked,
    text: over ? GUEST_BANNER_PARTY_OVER : GUEST_BANNER_PAUSED,
    partyOver: over,
  };
}

/**
 * @param {HTMLElement|null|undefined} el
 * @param {{ hidden: boolean, text: string, partyOver: boolean }} view
 */
export function paintGuestLockBanner(el, view) {
  if (!el || !view) return;
  el.hidden = !!view.hidden;
  el.textContent = view.text || "";
  el.classList.toggle("party-over", !!view.partyOver);
}
