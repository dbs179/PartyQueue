/** Memory (play-history) list render + load. */

import { escapeHtml } from "./format.js";
import { memorySourceBadge } from "./memory-badges.js";

/**
 * @param {object} track
 * @param {number} index
 */
export function memoryTrackRowHtml(track, index) {
  const art = track?.image
    ? `<img src="${track.image}" alt="" loading="lazy" />`
    : `<div class="art-fallback"></div>`;
  const badge = memorySourceBadge(
    track?.source,
    track?.skipped,
    track?.requestedBy,
    track?.mood
  );
  return `
      <span class="queue-index">${index + 1}</span>
      ${art}
      <div class="meta">
        <div class="title">${escapeHtml(track?.title || "Unknown")}${badge}</div>
        <div class="artist">${escapeHtml(track?.artist || "")}</div>
      </div>
    `;
}

/**
 * @param {{
 *   countEl?: HTMLElement|null,
 *   introEl?: HTMLElement|null,
 *   listEl?: HTMLElement|null,
 *   emptyEl?: HTMLElement|null,
 * }} els
 * @param {Array<object>} tracks
 */
export function renderMemory(els, tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  const { countEl, introEl, listEl, emptyEl } = els || {};
  if (!listEl) return;
  listEl.innerHTML = "";
  if (emptyEl) emptyEl.hidden = list.length > 0;
  if (introEl) introEl.hidden = list.length === 0;
  if (countEl) countEl.textContent = list.length ? `(${list.length})` : "";

  list.forEach((track, i) => {
    const li = document.createElement("li");
    li.className = "track";
    li.innerHTML = memoryTrackRowHtml(track, i);
    listEl.appendChild(li);
  });
}

/**
 * @param {{
 *   countEl?: HTMLElement|null,
 *   introEl?: HTMLElement|null,
 *   listEl?: HTMLElement|null,
 *   emptyEl?: HTMLElement|null,
 * }} els
 * @param {{ hostFetch: typeof fetch }} deps
 */
export async function loadMemory(els, deps) {
  const { countEl, introEl, emptyEl } = els || {};
  const hostFetch = deps?.hostFetch;
  if (emptyEl) emptyEl.hidden = true;
  if (introEl) introEl.hidden = true;
  if (countEl) countEl.textContent = "...";
  try {
    if (typeof hostFetch !== "function") throw new Error("Missing hostFetch");
    const res = await hostFetch("/api/history");
    if (!res.ok) throw new Error("Could not load memory.");
    const data = await res.json();
    renderMemory(els, data.tracks || []);
  } catch {
    if (countEl) countEl.textContent = "";
    if (emptyEl) {
      emptyEl.hidden = false;
      emptyEl.textContent = "Could not load memory.";
    }
  }
}
