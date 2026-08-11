/** Up Next list render, edit mode (delete/reorder), and Party Display queue. */

import { escapeHtml } from "./format.js";
import {
  sanitizeDisplayName,
  sanitizeDedication,
  dedicationDisplayLabel,
  guestOwnsQueueTrack,
} from "./guest.js";
import { trackEraDisplayLabel } from "./genre-presets.js";
import { displayOriginLabel } from "./now-playing-origin.js";
import { UNKNOWN_GENRE_DISPLAY } from "./mix-labels.js";

/**
 * @param {number} n
 */
export function mainQueueCountLabel(n) {
  return n > 0 ? `(${n})` : "";
}

/**
 * @param {number} n
 */
export function partyQueueCountLabel(n) {
  return n > 0 ? `${n} queued` : "";
}

/**
 * @param {object} track
 * @param {{ showQueueGenre?: boolean }} [opts]
 */
export function queueTrackSig(track, { showQueueGenre = false } = {}) {
  // Omit absolute Sonos position: trimPlayedTracks shifts every upcoming
  // index while the visible row is unchanged. Including position forced a
  // full row rebuild (badge/pill flash) every maintenance pass.
  return [
    track.uri || "",
    track.searched ? 1 : 0,
    track.discovered ? 1 : 0,
    track.moodPick ? 1 : 0,
    track.mood || "",
    track.requestedBy || "",
    track.requestedByUser || "",
    track.dedication || "",
    track.reactionSet || "",
    track.title || "",
    track.artist || "",
    track.djVoice ? 1 : 0,
    showQueueGenre ? 1 : 0,
    track.fromPlaylist ? 1 : 0,
    track.genreLane || "",
    track.genreLabel || "",
    Array.isArray(track.genreLabels) ? track.genreLabels.join(",") : "",
  ].join("\0");
}

/**
 * @param {object} track
 * @param {{ eraLabel?: string }} [opts]
 */
export function queueOriginBadgeHtml(track, { eraLabel = "" } = {}) {
  const requester = sanitizeDisplayName(track.requestedBy || "");
  const dedication = sanitizeDedication(track.dedication || "");
  if (track.moodPick) {
    const label = eraLabel ? `${eraLabel} Hit` : "Era Hit";
    return `<span class="mood-badge" title="Era hit added by the Decades mood (from outside your playlists)">\u{1F4FC} ${escapeHtml(label)}</span>`;
  }
  if (track.discovered) {
    return `<span class="songs-like-badge" title="Added by Discover (similar to your music)">\u2728 Discover</span>`;
  }
  if (track.reactionSet === "loved") {
    return `<span class="reaction-set-badge reaction-set-loved" title="Most Loved set from guest reactions">\u2764\uFE0F Most Loved</span>`;
  }
  if (track.reactionSet === "hated") {
    return `<span class="reaction-set-badge reaction-set-hated" title="Most Hated set from guest reactions">\u{1F922} Most Hated</span>`;
  }
  if (track.searched) {
    if (dedication) {
      const label = dedicationDisplayLabel(dedication, requester);
      return `<span class="searched-badge" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
    }
    const tip = requester
      ? `Requested by ${escapeHtml(requester)}`
      : "A guest searched and added this song (plays before auto-added songs)";
    const label = requester
      ? `\u{1F50D} Requested \u00b7 ${escapeHtml(requester)}`
      : `\u{1F50D} Requested`;
    return `<span class="searched-badge" title="${tip}">${label}</span>`;
  }
  if (track.djVoice) return "";
  return `<span class="memory-random-badge" title="Added by Random / Never-Ending">\u{1F3B2} Random</span>`;
}

/**
 * Matched genre text for an Up Next row (lane / label), or "".
 * @param {object} track
 */
export function queueGenreLabel(track) {
  if (!track || track.djVoice) return "";
  if (Array.isArray(track.genreLabels) && track.genreLabels[0]) {
    return String(track.genreLabels[0]);
  }
  if (typeof track.genreLabel === "string" && track.genreLabel) {
    return track.genreLabel;
  }
  if (typeof track.genreLane === "string" && track.genreLane) {
    return track.genreLane;
  }
  return "";
}

/**
 * @param {object} track
 * @param {{ showQueueGenre?: boolean }} [opts]
 */
export function queueGenreBadgeHtml(track, { showQueueGenre = false } = {}) {
  if (!showQueueGenre || track.djVoice) return "";
  const matched = queueGenreLabel(track);
  const unknown = !matched;
  const label = matched || UNKNOWN_GENRE_DISPLAY;
  const cls = unknown
    ? "queue-genre-badge is-unknown"
    : "queue-genre-badge";
  const title = unknown
    ? "Genre not matched yet"
    : "Matched song genre";
  return `<span class="${cls}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
}

/**
 * @param {object} track
 * @param {{ showQueueGenre?: boolean }} [opts]
 */
export function queuePlaylistBadgeHtml(track, { showQueueGenre = false } = {}) {
  if (!showQueueGenre || track.djVoice || !track.fromPlaylist) return "";
  return `<span class="queue-playlist-badge" title="This song is in your Spotify playlists">From Playlists</span>`;
}

/**
 * @param {object} track
 * @param {{ showQueueGenre?: boolean, eraLabel?: string }} [opts]
 */
export function queueBadgeHtml(track, opts = {}) {
  return `${queueOriginBadgeHtml(track, opts)}${queueGenreBadgeHtml(track, opts)}${queuePlaylistBadgeHtml(track, opts)}`;
}

/**
 * @param {{
 *   queueList?: HTMLElement|null,
 *   queueCount?: HTMLElement|null,
 *   queueEmpty?: HTMLElement|null,
 *   queueEditToggle?: HTMLElement|null,
 *   queueEditHint?: HTMLElement|null,
 *   displayQueue?: HTMLElement|null,
 *   displayQueueCount?: HTMLElement|null,
 *   displayQueueEmpty?: HTMLElement|null,
 * }} els
 * @param {{
 *   hostFetch: typeof fetch,
 *   showToast: (msg: string, isError?: boolean) => void,
 *   getShowQueueGenre: () => boolean,
 *   getActiveEraMoodId: () => string|null|undefined,
 *   getLastQueueTracks: () => object[],
 *   applyQueueTracks: (tracks: object[]) => void,
 *   loadQueue: (force?: boolean) => void|Promise<void>,
 *   Sortable?: { create: (el: HTMLElement, opts: object) => { destroy: () => void } },
 *   getGuestUser?: () => string,
 *   onDedicate?: (track: object) => void|Promise<void>,
 * }} deps
 */
export function createQueueUi(els, deps) {
  const {
    queueList,
    queueCount,
    queueEmpty,
    queueEditToggle,
    queueEditHint,
    displayQueue,
    displayQueueCount,
    displayQueueEmpty,
  } = els || {};

  const hostFetch = deps.hostFetch;
  const showToast = deps.showToast;
  const getShowQueueGenre = deps.getShowQueueGenre;
  const getActiveEraMoodId = deps.getActiveEraMoodId;
  const getLastQueueTracks = deps.getLastQueueTracks;
  const applyQueueTracks = deps.applyQueueTracks;
  const loadQueue = deps.loadQueue;
  const getGuestUser = deps.getGuestUser || (() => "");
  const onDedicate = deps.onDedicate || null;
  const SortableCtor = deps.Sortable || (typeof window !== "undefined" ? window.Sortable : null);

  let editMode = false;
  let guestLocked = false;
  let hasTracks = false;
  /** @type {{ destroy: () => void }|null} */
  let sortable = null;
  /** @type {object[]|null} */
  let pendingStreamTracks = null;
  /** @type {object[]} */
  let lastDisplayTracks = [];
  let lastDisplayQueueSig = "";
  /** @type {ResizeObserver|null} */
  let displayQueueResizeObserver = null;
  let displayQueueFitRaf = 0;

  const DISPLAY_QUEUE_MAX = 8;

  function displayQueueSection() {
    return displayQueue?.closest(".party-display-queue") || null;
  }

  /** How many Up Next rows fit in the panel at the current font size. */
  function measureDisplayQueueFit() {
    const section = displayQueueSection();
    if (!displayQueue || !section) return 4;
    const head = section.querySelector(".party-display-section-head");
    const sectionStyle = getComputedStyle(section);
    const padY =
      (parseFloat(sectionStyle.paddingTop) || 0) +
      (parseFloat(sectionStyle.paddingBottom) || 0);
    const headH = head ? head.getBoundingClientRect().height : 0;
    const listStyle = getComputedStyle(displayQueue);
    const listMarginTop = parseFloat(listStyle.marginTop) || 0;
    const available = section.clientHeight - padY - headH - listMarginTop;
    if (!(available > 0)) return 1;

    let probe = displayQueue.querySelector("li");
    let created = false;
    if (!probe) {
      const showGenre = !!getShowQueueGenre();
      probe = document.createElement("li");
      probe.setAttribute("aria-hidden", "true");
      probe.innerHTML =
        '<span class="party-display-queue-index">1</span>' +
        '<div class="party-display-queue-meta">' +
        "<strong>Sample Title</strong>" +
        "<span>Sample Artist</span>" +
        '<span class="party-display-queue-source">Random</span>' +
        (showGenre
          ? '<span class="party-display-queue-genre">Rock</span>' +
            '<span class="party-display-queue-playlist">From Playlists</span>'
          : "") +
        "</div>";
      probe.style.visibility = "hidden";
      probe.style.pointerEvents = "none";
      displayQueue.appendChild(probe);
      created = true;
    }
    const gap =
      parseFloat(listStyle.rowGap || listStyle.gap || "0") || 0;
    const rowH = probe.getBoundingClientRect().height + gap;
    if (created) probe.remove();
    if (!(rowH > 0)) return 4;
    return Math.max(
      1,
      Math.min(DISPLAY_QUEUE_MAX, Math.floor(available / rowH))
    );
  }

  function trimDisplayQueueOverflow() {
    if (!displayQueue) return;
    const section = displayQueueSection();
    if (!section) return;
    // Drop trailing rows until the panel no longer overflows.
    while (
      displayQueue.children.length > 1 &&
      section.scrollHeight > section.clientHeight + 1
    ) {
      displayQueue.lastElementChild?.remove();
    }
  }

  function ensureDisplayQueueObserver() {
    if (
      displayQueueResizeObserver ||
      !displayQueue ||
      typeof ResizeObserver === "undefined"
    ) {
      return;
    }
    const section = displayQueueSection();
    if (!section) return;
    displayQueueResizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(displayQueueFitRaf);
      displayQueueFitRaf = requestAnimationFrame(() => {
        renderPartyDisplay(lastDisplayTracks);
      });
    });
    displayQueueResizeObserver.observe(section);
  }

  function badgeOpts(track) {
    const showQueueGenre = !!getShowQueueGenre();
    const eraLabel = trackEraDisplayLabel(track, getActiveEraMoodId());
    return { showQueueGenre, eraLabel };
  }

  function syncEditButton() {
    if (queueEditToggle) {
      queueEditToggle.hidden = guestLocked || !hasTracks;
    }
  }

  function syncSortable() {
    if (sortable) {
      sortable.destroy();
      sortable = null;
    }
    if (editMode && SortableCtor && queueList?.children.length) {
      sortable = SortableCtor.create(queueList, {
        animation: 150,
        filter: ".track-delete",
        preventOnFilter: false,
        delay: 200,
        delayOnTouchOnly: true,
        onEnd: onQueueReorder,
      });
    }
  }

  async function onQueueReorder(evt) {
    if (evt.oldIndex === evt.newIndex) return;
    const li = evt.item;
    const before = li.nextElementSibling;
    const body = {
      uri: li.dataset.uri,
      fromPosition: Number(li.dataset.position),
      beforeUri: before ? before.dataset.uri : null,
      beforePosition: before ? Number(before.dataset.position) : null,
    };
    try {
      const res = await hostFetch("/api/queue/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not move the song.");
      showToast("Moved");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      void loadQueue(true);
    }
  }

  async function removeQueueItem(li) {
    const title = li.querySelector(".title")?.textContent || "song";
    const body = {
      uri: li.dataset.uri,
      position: Number(li.dataset.position),
    };
    li.style.opacity = "0.4";
    try {
      const res = await hostFetch("/api/queue/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not remove the song.");
      showToast(`Removed "${title}"`);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      void loadQueue(true);
    }
  }

  function queueRowSig(track) {
    const owns = guestOwnsQueueTrack(track, getGuestUser()) ? "1" : "0";
    return `${queueTrackSig(track, badgeOpts(track))}|${owns}`;
  }

  function fillQueueRow(li, track, index) {
    li.className = "track track-noart" + (editMode ? " editing" : "");
    li.dataset.uri = track.uri || "";
    li.dataset.position = String(track.position || index + 1);
    li.dataset.sig = queueRowSig(track);
    const del = editMode
      ? `<button class="track-delete" type="button" aria-label="Remove from queue" title="Remove from queue">&times;</button>`
      : "";
    const canDedicate =
      !editMode &&
      onDedicate &&
      track.searched &&
      !track.djVoice &&
      guestOwnsQueueTrack(track, getGuestUser());
    const hasDedication = !!sanitizeDedication(track.dedication || "");
    const dedicate = canDedicate
      ? `<button class="track-dedicate" type="button">${
          hasDedication ? "Edit" : "Dedicate"
        }</button>`
      : "";
    const badge = queueBadgeHtml(track, badgeOpts(track));
    li.innerHTML = `
      <span class="queue-index">${index + 1}</span>
      <div class="meta">
        <div class="title">${escapeHtml(track.title)}</div>
        <div class="artist">${escapeHtml(track.artist)}</div>
        ${badge ? `<div class="queue-tag">${badge}</div>` : ""}
      </div>
      ${dedicate}
      ${del}
    `;
    if (editMode) {
      li.querySelector(".track-delete").addEventListener("click", () =>
        removeQueueItem(li)
      );
    } else if (canDedicate) {
      li.querySelector(".track-dedicate")?.addEventListener("click", (e) => {
        e.stopPropagation();
        void onDedicate(track);
      });
    }
  }

  function render(tracks) {
    if (!queueList) return;
    const list = Array.isArray(tracks) ? tracks : [];
    if (queueCount) queueCount.textContent = mainQueueCountLabel(list.length);
    if (queueEmpty) {
      queueEmpty.textContent = "The queue is empty.";
      queueEmpty.hidden = list.length > 0;
    }
    hasTracks = list.length > 0;
    syncEditButton();

    const wantEdit = editMode;
    const kids = [...queueList.children];
    const canPatch =
      !wantEdit &&
      kids.length === list.length &&
      kids.every(
        (li) =>
          li.classList.contains("track") && !li.classList.contains("editing")
      );

    if (canPatch) {
      let changed = false;
      list.forEach((track, i) => {
        const li = kids[i];
        const sig = queueRowSig(track);
        if (li.dataset.sig !== sig) {
          fillQueueRow(li, track, i);
          changed = true;
        } else {
          const idxEl = li.querySelector(".queue-index");
          if (idxEl && idxEl.textContent !== String(i + 1)) {
            idxEl.textContent = String(i + 1);
            changed = true;
          }
          li.dataset.position = String(track.position || i + 1);
        }
      });
      if (!changed) return;
      syncSortable();
      return;
    }

    queueList.innerHTML = "";
    list.forEach((track, i) => {
      const li = document.createElement("li");
      fillQueueRow(li, track, i);
      queueList.appendChild(li);
    });
    syncSortable();
  }

  function renderPartyDisplay(tracks) {
    if (!displayQueue || !displayQueueEmpty || !displayQueueCount) return;
    const list = Array.isArray(tracks) ? tracks : [];
    lastDisplayTracks = list;
    ensureDisplayQueueObserver();

    displayQueueCount.textContent = partyQueueCountLabel(list.length);
    displayQueueEmpty.textContent = "The queue is empty.";

    if (list.length === 0) {
      displayQueue.innerHTML = "";
      displayQueueEmpty.hidden = false;
      lastDisplayQueueSig = "";
      return;
    }
    displayQueueEmpty.hidden = true;

    const fit = measureDisplayQueueFit();
    const visible = list.slice(0, fit);
    const eraMood = getActiveEraMoodId();
    const showGenre = getShowQueueGenre();
    const nextSig = visible
      .map(
        (track) =>
          queueTrackSig(track, { showQueueGenre: showGenre }) +
          "\0" +
          displayOriginLabel(track, eraMood)
      )
      .join("\n");
    // Skip DOM wipe when trim only shifted absolute positions.
    if (
      nextSig === lastDisplayQueueSig &&
      displayQueue.children.length === visible.length
    ) {
      return;
    }
    lastDisplayQueueSig = nextSig;
    displayQueue.innerHTML = "";

    visible.forEach((track, index) => {
      const row = document.createElement("li");
      const number = document.createElement("span");
      number.className = "party-display-queue-index";
      number.textContent = String(index + 1);

      const meta = document.createElement("div");
      meta.className = "party-display-queue-meta";
      const title = document.createElement("strong");
      title.textContent = track.title || "Untitled";
      const artist = document.createElement("span");
      artist.textContent = track.artist || "";
      meta.append(title, artist);

      if (!track.djVoice) {
        const source = document.createElement("span");
        source.className = "party-display-queue-source";
        source.textContent = displayOriginLabel(track, eraMood);
        meta.appendChild(source);

        // Same Show song genre toggle as main Up Next (genre + From Playlists).
        if (showGenre) {
          const matched = queueGenreLabel(track);
          const genre = document.createElement("span");
          genre.className = matched
            ? "party-display-queue-genre"
            : "party-display-queue-genre is-unknown";
          genre.textContent = matched || UNKNOWN_GENRE_DISPLAY;
          genre.title = matched
            ? "Matched song genre"
            : "Genre not matched yet";
          meta.appendChild(genre);
          if (track.fromPlaylist) {
            const playlist = document.createElement("span");
            playlist.className = "party-display-queue-playlist";
            playlist.textContent = "From Playlists";
            playlist.title = "This song is in your Spotify playlists";
            meta.appendChild(playlist);
          }
        }
      }

      row.append(number, meta);
      displayQueue.appendChild(row);
    });
    trimDisplayQueueOverflow();
  }

  function isEditMode() {
    return editMode;
  }

  function setPendingStreamTracks(tracks) {
    pendingStreamTracks = Array.isArray(tracks) ? tracks : [];
  }

  function clearPendingStreamTracks() {
    pendingStreamTracks = null;
  }

  function setGuestEditLocked(locked) {
    guestLocked = !!locked;
    syncEditButton();
    if (guestLocked && editMode) {
      editMode = false;
      queueEditToggle?.classList.remove("active");
      queueEditToggle?.setAttribute("aria-pressed", "false");
      if (queueEditToggle) queueEditToggle.textContent = "Edit";
      if (queueEditHint) queueEditHint.hidden = true;
      syncSortable();
      void loadQueue(true);
    }
  }

  queueEditToggle?.addEventListener("click", () => {
    editMode = !editMode;
    queueEditToggle.classList.toggle("active", editMode);
    queueEditToggle.setAttribute("aria-pressed", String(editMode));
    queueEditToggle.textContent = editMode ? "Done" : "Edit";
    if (queueEditHint) queueEditHint.hidden = !editMode;
    if (!editMode && pendingStreamTracks) {
      const tracks = pendingStreamTracks;
      pendingStreamTracks = null;
      applyQueueTracks(tracks);
    } else {
      render(getLastQueueTracks());
      void loadQueue(true);
    }
  });

  return {
    render,
    renderPartyDisplay,
    isEditMode,
    setGuestEditLocked,
    setPendingStreamTracks,
    clearPendingStreamTracks,
    syncEditButton,
  };
}
