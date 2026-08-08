/** Stats page list / card HTML helpers (no fetch, thin DOM paint). */

import { escapeHtml } from "./format.js";
import {
  sanitizeDisplayName,
  dedicationDisplayLabel,
} from "./guest.js";

export const REACTION_EMOJI = {
  up: "\u{1F44D}",
  down: "\u{1F44E}",
  heart: "\u2764\uFE0F",
  fire: "\u{1F525}",
  laugh: "\u{1F602}",
  vomit: "\u{1F92E}",
  party: "\u{1F389}",
  mic: "\u{1F3A4}",
};

/** @param {string[]|null|undefined} names */
export function formatNameList(names) {
  return (Array.isArray(names) ? names : [])
    .map((n) => sanitizeDisplayName(n) || "Guest")
    .filter(Boolean)
    .join(", ");
}

/**
 * @param {Array<object>|null|undefined} items
 * @param {"song"|"artist"|"requester"} primaryKey
 */
export function statRows(items, primaryKey) {
  return (Array.isArray(items) ? items : [])
    .map((it, i) => {
      const main =
        primaryKey === "song"
          ? escapeHtml(it.name || "Unknown")
          : primaryKey === "requester"
            ? escapeHtml(it.name || "Guest")
            : escapeHtml(it.artist);
      const sub =
        primaryKey === "song" && it.artist
          ? `<span class="stats-sub">${escapeHtml(it.artist)}</span>`
          : "";
      return `<li class="stats-row"><span class="stats-rank">${i + 1}</span><span class="stats-name">${main}${sub}</span><span class="stats-count">${it.count}\u00d7</span></li>`;
    })
    .join("");
}

/**
 * @param {HTMLElement|null|undefined} wrap
 * @param {HTMLElement|null|undefined} listEl
 * @param {Array<object>|null|undefined} items
 * @param {{ byPrefix?: string }} [opts]
 */
export function paintStatsReactionList(
  wrap,
  listEl,
  items,
  { byPrefix = "" } = {}
) {
  if (!wrap || !listEl) return;
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) {
    wrap.hidden = true;
    listEl.innerHTML = "";
    return;
  }
  wrap.hidden = false;
  listEl.innerHTML = rows
    .map((it, i) => {
      const main = escapeHtml(it.name || "Unknown");
      const artist = it.artist
        ? `<span class="stats-sub">${escapeHtml(it.artist)}</span>`
        : "";
      const groups = (Array.isArray(it.reactions) ? it.reactions : [])
        .map((r) => {
          const emoji = REACTION_EMOJI[r.kind] || r.kind;
          const who = formatNameList(r.by);
          return who ? `${emoji} ${escapeHtml(who)}` : "";
        })
        .filter(Boolean)
        .join(" \u00b7 ");
      const whoLine =
        !groups && byPrefix
          ? (() => {
              const who = formatNameList(it.by);
              return who
                ? `<span class="stats-sub">${escapeHtml(byPrefix)} ${escapeHtml(who)}</span>`
                : "";
            })()
          : groups
            ? `<span class="stats-sub">${groups}</span>`
            : "";
      return `<li class="stats-row"><span class="stats-rank">${i + 1}</span><span class="stats-name">${main}${artist}${whoLine}</span><span class="stats-count">${it.count}\u00d7</span></li>`;
    })
    .join("");
}

/**
 * @param {{
 *   total?: number,
 *   topSongs?: Array<{ name?: string }>,
 *   topArtists?: Array<{ artist?: string }>,
 *   topRequesters?: Array<{ name?: string, count?: number }>,
 * }} s
 */
export function statsSummaryCardsHtml(s) {
  const topSong = s?.topSongs?.[0];
  const topArtist = s?.topArtists?.[0];
  const topRequester = s?.topRequesters?.[0];
  return `
    <div class="stat-card"><div class="stat-num">${s?.total || 0}</div><div class="stat-cap">requests</div></div>
    <div class="stat-card"><div class="stat-lead">${topSong ? escapeHtml(topSong.name || "Unknown") : "\u2014"}</div><div class="stat-cap">top song</div></div>
    <div class="stat-card"><div class="stat-lead">${topArtist ? escapeHtml(topArtist.artist) : "\u2014"}</div><div class="stat-cap">top artist</div></div>
    <div class="stat-card"><div class="stat-lead">${topRequester ? escapeHtml(topRequester.name) : "\u2014"}</div><div class="stat-cap">top requestor${topRequester ? ` \u00b7 ${topRequester.count}\u00d7` : ""}</div></div>
  `;
}

/** @param {Array<object>|null|undefined} wall */
export function dedicationsHtml(wall) {
  return (Array.isArray(wall) ? wall : [])
    .map((d) => {
      const label = dedicationDisplayLabel(d.dedication, d.requestedBy);
      const song = [d.name, d.artist].filter(Boolean).join(" — ");
      return `<li class="stats-row"><span class="stats-name">${escapeHtml(label)}${
        song
          ? `<span class="stats-sub">${escapeHtml(song)}</span>`
          : ""
      }</span></li>`;
    })
    .join("");
}

/** @param {Array<object>|null|undefined} karaoke */
export function karaokeRowsHtml(karaoke) {
  return (Array.isArray(karaoke) ? karaoke : [])
    .map((it, i) => {
      const main = escapeHtml(it.name || "Unknown");
      const artist = it.artist
        ? `<span class="stats-sub">${escapeHtml(it.artist)}</span>`
        : "";
      const who = formatNameList(it.by);
      const byLine = who
        ? `<span class="stats-sub">Mic'd by ${escapeHtml(who)}</span>`
        : "";
      return `<li class="stats-row"><span class="stats-rank">${i + 1}</span><span class="stats-name">${main}${artist}${byLine}</span><span class="stats-count" title="Mic taps">${REACTION_EMOJI.mic} ${it.count}</span></li>`;
    })
    .join("");
}

/** @param {"tonight"|"all"|string} statsWindow */
export function statsEmptyMessage(statsWindow) {
  return statsWindow === "tonight"
    ? "No requests yet tonight \u2014 search and add a song to get the party started."
    : "No requests yet \u2014 search and add a song to get the party started.";
}
