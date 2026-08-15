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

/** Party Display subtitle: "1 Request" / "14 Requests". */
export function requestCountLabel(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return n === 1 ? "1 Request" : `${n} Requests`;
}

function requestCountSub(count) {
  if (count == null || count === "") return "";
  const n = Number(count);
  if (!Number.isFinite(n)) return "";
  return `<span class="party-display-stat-sub">${escapeHtml(requestCountLabel(n))}</span>`;
}

/** Party Display subtitle for reaction ranks: "1 Reaction" / "4 Reactions". */
export function reactionCountLabel(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return n === 1 ? "1 Reaction" : `${n} Reactions`;
}

function reactionCountSub(count) {
  if (count == null || count === "") return "";
  const n = Number(count);
  if (!Number.isFinite(n)) return "";
  return `<span class="party-display-stat-sub">${escapeHtml(reactionCountLabel(n))}</span>`;
}

/**
 * @param {Array<object>|null|undefined} items
 * @param {"song"|"artist"|"requester"|"set"} primaryKey
 */
export function statRows(items, primaryKey) {
  return (Array.isArray(items) ? items : [])
    .map((it, i) => {
      const main =
        primaryKey === "song" || primaryKey === "set"
          ? escapeHtml(it.name || (primaryKey === "set" ? "Unknown set" : "Unknown"))
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
 * @param {{ byPrefix?: string, alwaysShow?: boolean, emptyLabel?: string }} [opts]
 */
export function paintStatsReactionList(
  wrap,
  listEl,
  items,
  { byPrefix = "", alwaysShow = false, emptyLabel = "None yet" } = {}
) {
  if (!wrap || !listEl) return;
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) {
    if (alwaysShow) {
      wrap.hidden = false;
      listEl.innerHTML = `<li class="stats-row stats-row-empty"><span class="stats-name">${escapeHtml(emptyLabel)}</span></li>`;
    } else {
      wrap.hidden = true;
      listEl.innerHTML = "";
    }
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
  const song = topSong ? escapeHtml(topSong.name || "Unknown") : "\u2014";
  const artist = topArtist ? escapeHtml(topArtist.artist || "Unknown") : "\u2014";
  const requester = topRequester
    ? `${escapeHtml(topRequester.name || "Guest")}${
        topRequester.count != null ? ` \u00b7 ${topRequester.count}\u00d7` : ""
      }`
    : "\u2014";
  return `
    <div class="stat-card"><div class="stat-line">Requests: ${s?.total || 0}</div></div>
    <div class="stat-card"><div class="stat-line">Top song: ${song}</div></div>
    <div class="stat-card"><div class="stat-line">Top artist: ${artist}</div></div>
    <div class="stat-card"><div class="stat-line">Top requestor: ${requester}</div></div>
  `;
}

/**
 * Compact request tiles for Party Display (TV). Same shape as the Stats
 * page tonight / all-time windows.
 * @param {object|null|undefined} windowStats
 */
export function displayWindowStatsHtml(windowStats) {
  const s = windowStats || {};
  const topSong = s.topSongs?.[0];
  const topArtist = s.topArtists?.[0];
  const topRequester = s.topRequesters?.[0];
  const song = topSong
    ? escapeHtml(topSong.name || "Unknown")
    : "\u2014";
  const artist = topArtist
    ? escapeHtml(topArtist.artist || "Unknown")
    : "\u2014";
  const requester = topRequester
    ? escapeHtml(topRequester.name || "Guest")
    : "\u2014";
  const requesterSub = requestCountSub(topRequester?.count);
  const songSub = requestCountSub(topSong?.count);
  const artistSub = requestCountSub(topArtist?.count);
  const loved = s.topLiked?.[0];
  const hated = s.mostHated?.[0];
  const lovedTitle = loved ? escapeHtml(loved.name || "Unknown") : "\u2014";
  const hatedTitle = hated ? escapeHtml(hated.name || "Unknown") : "\u2014";
  const lovedSub = reactionCountSub(loved?.count);
  const hatedSub = reactionCountSub(hated?.count);
  return `
    <div class="party-display-stat">
      <span class="party-display-stat-label">Total Requests</span>
      <strong>${Number(s.total) || 0}</strong>
    </div>
    <div class="party-display-stat">
      <span class="party-display-stat-label">Top requestor</span>
      <strong>${requester}</strong>${requesterSub}
    </div>
    <div class="party-display-stat">
      <span class="party-display-stat-label">Top song</span>
      <strong>${song}</strong>${songSub}
    </div>
    <div class="party-display-stat">
      <span class="party-display-stat-label">Top artist</span>
      <strong>${artist}</strong>${artistSub}
    </div>
    <div class="party-display-stat">
      <span class="party-display-stat-label">Most Loved</span>
      <strong>${lovedTitle}</strong>${lovedSub}
    </div>
    <div class="party-display-stat">
      <span class="party-display-stat-label">Most Hated</span>
      <strong>${hatedTitle}</strong>${hatedSub}
    </div>
  `;
}

/**
 * @param {object|null|undefined} stats
 */
export function displayTonightStatsHtml(stats) {
  return displayWindowStatsHtml(stats?.tonight);
}

/**
 * @param {{
 *   tonightGrid?: HTMLElement|null,
 *   allTimeGrid?: HTMLElement|null,
 * }|HTMLElement|null|undefined} targets
 * @param {object|null|undefined} stats
 */
export function paintDisplayTonightStats(targets, stats) {
  const tonightGrid =
    targets && "tonightGrid" in targets ? targets.tonightGrid : targets;
  const allTimeGrid =
    targets && "allTimeGrid" in targets ? targets.allTimeGrid : null;
  if (tonightGrid) tonightGrid.innerHTML = displayWindowStatsHtml(stats?.tonight);
  if (allTimeGrid) allTimeGrid.innerHTML = displayWindowStatsHtml(stats?.allTime);
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
