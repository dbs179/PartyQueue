/** Closing Time / party recap overlay helpers. */

import { escapeHtml } from "./format.js";
import { attachModal } from "./modal.js";

/**
 * Resolve the end-of-night song label for guest-facing copy.
 * @param {object|null|undefined} recap
 * @param {() => string} [getEndOfNightName]
 */
export function closingTimeSongName(recap, getEndOfNightName) {
  const fromRecap = String(recap?.endOfNightName || "").trim();
  if (fromRecap) return fromRecap;
  const fromSettings =
    typeof getEndOfNightName === "function"
      ? String(getEndOfNightName() || "").trim()
      : "";
  return fromSettings || "Closing Time";
}

/**
 * Short toast when last call hits — clear even if the recap modal is open.
 * @param {string} songName
 */
export function closingTimeToastMessage(songName) {
  const song = String(songName || "").trim() || "Closing Time";
  return `Last call — no more requests. ${song} is next.`;
}

/**
 * Recap modal hint under the title.
 * @param {string} songName
 */
export function closingTimeHintText(songName) {
  return closingTimeToastMessage(songName);
}

/**
 * @param {object|null|undefined} recap
 * @returns {string}
 */
export function buildPartyRecapHtml(recap) {
  const payload = recap && typeof recap === "object" ? recap : null;
  if (!payload) return "";
  const lines = [];
  const total = Number(payload.total) || 0;
  lines.push(
    `<p><span class="recap-stat">${total}</span> request${total === 1 ? "" : "s"} tonight</p>`
  );
  const songs = Array.isArray(payload.topSongs) ? payload.topSongs : [];
  if (songs.length) {
    lines.push('<p class="recap-stat">Top songs</p><ul>');
    for (const s of songs.slice(0, 3)) {
      const label = s.artist ? `${s.name} — ${s.artist}` : s.name;
      lines.push(`<li>${escapeHtml(label)} (${s.count})</li>`);
    }
    lines.push("</ul>");
  }
  const people = Array.isArray(payload.topRequesters) ? payload.topRequesters : [];
  if (people.length) {
    lines.push('<p class="recap-stat">Top requestors</p><ul>');
    for (const p of people.slice(0, 3)) {
      lines.push(`<li>${escapeHtml(p.name)} (${p.count})</li>`);
    }
    lines.push("</ul>");
  }
  return lines.join("");
}

/**
 * @param {number|null|undefined} ts
 * @param {number} lastShown
 * @param {number} [now]
 */
export function shouldAnnounceClosingTime(ts, lastShown, now = Date.now()) {
  const t = Number(ts) || 0;
  if (!t || t <= (Number(lastShown) || 0)) {
    return { announce: false, nextLastShown: Number(lastShown) || 0 };
  }
  const next = t;
  if (now - t > 60_000) return { announce: false, nextLastShown: next };
  return { announce: true, nextLastShown: next };
}

/**
 * @param {{
 *   overlay?: HTMLElement|null,
 *   body?: HTMLElement|null,
 *   hintEl?: HTMLElement|null,
 *   dismissBtn?: HTMLElement|null,
 *   titleEl?: HTMLElement|null,
 * }} els
 * @param {{
 *   showToast: (msg: string, isError?: boolean, durationMs?: number) => void,
 *   getEndOfNightName?: () => string,
 * }} deps
 */
export function createPartyRecapUi(els, deps) {
  const { overlay, body, hintEl, dismissBtn, titleEl } = els || {};
  const showToast = deps?.showToast || (() => {});
  const getEndOfNightName = deps?.getEndOfNightName || (() => "Closing Time");

  let lastClosingShown = 0;
  let lastPartyRecapPayload = null;
  /** @type {{ close: () => void }|null} */
  let recapModalSession = null;

  function hidePartyRecap() {
    if (recapModalSession) {
      const session = recapModalSession;
      recapModalSession = null;
      session.close();
      return;
    }
    if (overlay) overlay.hidden = true;
  }

  function showPartyRecap(recap) {
    lastPartyRecapPayload = recap && typeof recap === "object" ? recap : null;
    const songName = closingTimeSongName(
      lastPartyRecapPayload,
      getEndOfNightName
    );
    const toast = closingTimeToastMessage(songName);
    const hint = closingTimeHintText(songName);

    if (titleEl) titleEl.textContent = "Last call";
    if (hintEl) hintEl.textContent = hint;
    // Always toast so guests who dismiss the modal (or miss it) still see
    // that requests are closed and which song is next.
    showToast(toast, false, 5000);

    if (!overlay || !body || !lastPartyRecapPayload) {
      return;
    }
    body.innerHTML = buildPartyRecapHtml(lastPartyRecapPayload);
    recapModalSession?.close();
    recapModalSession = attachModal(overlay, {
      initialFocus: dismissBtn,
      onEscape: hidePartyRecap,
      allowBackdrop: true,
      onBackdrop: hidePartyRecap,
    });
  }

  function maybeAnnounceClosingTime(ts, partyRecap) {
    const gate = shouldAnnounceClosingTime(ts, lastClosingShown);
    lastClosingShown = gate.nextLastShown;
    if (!gate.announce) return;
    showPartyRecap(partyRecap);
  }

  function markClosingShown(ts) {
    const t = Number(ts) || 0;
    if (t > lastClosingShown) lastClosingShown = t;
  }

  dismissBtn?.addEventListener("click", hidePartyRecap);

  return {
    showPartyRecap,
    hidePartyRecap,
    maybeAnnounceClosingTime,
    markClosingShown,
  };
}
