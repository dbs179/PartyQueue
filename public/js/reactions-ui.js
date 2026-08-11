/** Now Playing reactions (mood + karaoke mic) and Party Display counts. */

/** Stable order — keep in sync with src/reactions.js. */
export const NP_REACTION_KINDS = [
  "up",
  "down",
  "heart",
  "fire",
  "laugh",
  "vomit",
  "party",
  "mic",
];

export const NP_MOOD_REACTION_KINDS = NP_REACTION_KINDS.filter((k) => k !== "mic");

export const REACT_GUEST_KEY = "pq.reactGuestId";
export const REACTIONS_HINT_SEEN_KEY = "pq.reactionsHintSeen";

export function emptyReactionCounts() {
  return Object.fromEntries(NP_REACTION_KINDS.map((k) => [k, 0]));
}

/**
 * @param {Pick<Storage, "getItem">|null|undefined} storage
 */
export function reactionsHintSeen(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(REACTIONS_HINT_SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

/**
 * @param {Pick<Storage, "setItem">|null|undefined} storage
 */
export function markReactionsHintSeen(storage = globalThis.localStorage) {
  try {
    storage?.setItem(REACTIONS_HINT_SEEN_KEY, "1");
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * @param {Record<string, unknown>|null|undefined} data
 */
export function normalizeReactionCounts(data) {
  return Object.fromEntries(
    NP_REACTION_KINDS.map((k) => [k, Math.max(0, Number(data?.[k]) || 0)])
  );
}

/**
 * @param {unknown} mine
 * @returns {string|null}
 */
export function resolveMyMood(mine) {
  return mine && NP_MOOD_REACTION_KINDS.includes(mine) ? mine : null;
}

/**
 * @param {string} id
 */
export function isValidReactGuestId(id) {
  return /^[A-Za-z0-9_-]{8,64}$/.test(String(id || ""));
}

/**
 * @param {{ randomUUID?: () => string }|undefined} cryptoObj
 * @param {() => number} now
 * @param {() => number} random
 */
export function createReactGuestId(
  cryptoObj = globalThis.crypto,
  now = Date.now,
  random = Math.random
) {
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID().replace(/-/g, "");
  }
  return `g${now().toString(36)}${random().toString(36).slice(2, 10)}`;
}

/**
 * @param {Pick<Storage, "getItem"|"setItem">|null|undefined} storage
 */
export function getReactGuestId(storage = globalThis.localStorage) {
  try {
    let id = storage?.getItem(REACT_GUEST_KEY) || "";
    if (!isValidReactGuestId(id)) {
      id = createReactGuestId();
      storage?.setItem(REACT_GUEST_KEY, id);
    }
    return id;
  } catch {
    return `g${Date.now().toString(36)}`;
  }
}

/**
 * Optimistic mood (exclusive) / mic (toggle) update.
 * @param {{
 *   counts: Record<string, number>,
 *   mine: string|null,
 *   micMine: boolean,
 *   kind: string,
 * }} args
 * @returns {{ counts: Record<string, number>, mine: string|null, micMine: boolean }|null}
 */
export function computeOptimisticReaction({ counts, mine, micMine, kind }) {
  if (!NP_REACTION_KINDS.includes(kind)) return null;
  const next = { ...counts };
  let nextMine = mine;
  let nextMic = micMine;
  if (kind === "mic") {
    nextMic = !micMine;
    next.mic = Math.max(0, (next.mic || 0) + (nextMic ? 1 : -1));
  } else if (mine === kind) {
    nextMine = null;
    next[kind] = Math.max(0, (next[kind] || 0) - 1);
  } else {
    if (mine) next[mine] = Math.max(0, (next[mine] || 0) - 1);
    nextMine = kind;
    next[kind] = (next[kind] || 0) + 1;
  }
  return { counts: next, mine: nextMine, micMine: nextMic };
}

/**
 * @param {{
 *   npReactions?: HTMLElement|null,
 *   npReactionsHint?: HTMLElement|null,
 *   displayReactions?: HTMLElement|null,
 *   clearReactionsBtn?: HTMLElement|null,
 *   clearKaraokeBtn?: HTMLElement|null,
 * }} els
 * @param {{
 *   fetch?: typeof fetch,
 *   hostFetch: typeof fetch,
 *   showToast: (msg: string, isError?: boolean) => void,
 *   confirmModal: (message: string, confirmLabel?: string, cancelLabel?: string) => Promise<boolean>,
 *   getNowPlayingId: () => string|null,
 *   getNowPlayingMeta: () => { title?: string|null, artist?: string|null },
 *   ensureDisplayName: (opts?: { required?: boolean }) => Promise<string|null|undefined>,
 *   guestBadgeName: () => string,
 *   getCurrentView: () => string,
 *   loadStats: () => void|Promise<void>,
 *   storage?: Pick<Storage, "getItem"|"setItem">|null,
 * }} deps
 */
export function createReactionsUi(els, deps) {
  const {
    npReactions,
    npReactionsHint,
    displayReactions,
    clearReactionsBtn,
    clearKaraokeBtn,
  } = els || {};

  const fetchFn = deps.fetch || fetch;
  const hostFetch = deps.hostFetch;
  const showToast = deps.showToast;
  const confirmModal = deps.confirmModal;
  const getNowPlayingId = deps.getNowPlayingId;
  const getNowPlayingMeta = deps.getNowPlayingMeta;
  const ensureDisplayName = deps.ensureDisplayName;
  const guestBadgeName = deps.guestBadgeName;
  const getCurrentView = deps.getCurrentView;
  const loadStats = deps.loadStats;
  const storage = deps.storage ?? globalThis.localStorage;

  let counts = emptyReactionCounts();
  /** @type {string|null} */
  let myMood = null;
  let myMic = false;
  let busy = false;
  /** @type {string|null} */
  let syncedFor = null;

  function dismissReactionsHint() {
    if (npReactionsHint) npReactionsHint.hidden = true;
    markReactionsHintSeen(storage);
  }

  function syncReactionsHint(reactionsVisible) {
    if (!npReactionsHint) return;
    if (!reactionsVisible || reactionsHintSeen(storage)) {
      npReactionsHint.hidden = true;
      return;
    }
    npReactionsHint.hidden = false;
  }

  function paint(data) {
    counts = normalizeReactionCounts(data);
    if (data && Object.prototype.hasOwnProperty.call(data, "mine")) {
      myMood = resolveMyMood(data.mine);
    }
    if (data && Object.prototype.hasOwnProperty.call(data, "micMine")) {
      myMic = !!data.micMine;
    }
    if (npReactions) {
      for (const el of npReactions.querySelectorAll("[data-count]")) {
        const kind = el.getAttribute("data-count");
        el.textContent = String(counts[kind] || 0);
      }
      for (const btn of npReactions.querySelectorAll("[data-react]")) {
        const kind = btn.getAttribute("data-react");
        const on = kind === "mic" ? myMic : kind === myMood;
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      }
    }
    if (displayReactions) {
      for (const el of displayReactions.querySelectorAll("[data-display-count]")) {
        const kind = el.getAttribute("data-display-count");
        el.textContent = String(counts[kind] || 0);
      }
    }
  }

  async function syncMyReactions(trackId) {
    if (!trackId) {
      myMood = null;
      myMic = false;
      syncedFor = null;
      paint({});
      return;
    }
    if (syncedFor === trackId) return;
    try {
      const qs = new URLSearchParams({
        id: trackId,
        guestId: getReactGuestId(),
      });
      const res = await fetchFn(`/api/reactions?${qs}`);
      if (!res.ok) return;
      const data = await res.json();
      syncedFor = trackId;
      paint(data);
    } catch {
      /* keep prior paint */
    }
  }

  /** Reset local mine/mic when the Now Playing track id changes. */
  function noteTrackChange(nextNpId) {
    if (nextNpId !== syncedFor) {
      myMood = null;
      myMic = false;
      syncedFor = null;
    }
  }

  /**
   * Apply NP poll payload + optional guest sync.
   * @param {object|null|undefined} np
   * @param {{ hasTrack: boolean, updating: boolean }} opts
   */
  function applyFromNowPlaying(np, { hasTrack, updating }) {
    if (!hasTrack) {
      if (npReactions) npReactions.hidden = true;
      syncReactionsHint(false);
      syncedFor = null;
      paint({ mine: null, micMine: false });
      return;
    }
    if (npReactions) npReactions.hidden = updating;
    syncReactionsHint(!!npReactions && !updating && !npReactions.hidden);
    if (np?.reactions) {
      paint({
        ...np.reactions,
        mine: myMood,
        micMine: myMic,
      });
    }
    if (!updating) void syncMyReactions(getNowPlayingId());
  }

  function setDisplayHidden(hidden) {
    if (displayReactions) displayReactions.hidden = !!hidden;
  }

  function invalidateAndResync() {
    syncedFor = null;
    const id = getNowPlayingId();
    if (id) void syncMyReactions(id);
    else paint({ mine: null, micMine: false });
  }

  function getSyncedFor() {
    return syncedFor;
  }

  npReactionsHint?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dismissReactionsHint();
  });

  npReactions?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-react]");
    if (!btn || busy) return;
    e.preventDefault();
    e.stopPropagation();
    const kind = btn.getAttribute("data-react");
    const id = getNowPlayingId();
    if (!id || !NP_REACTION_KINDS.includes(kind)) return;

    dismissReactionsHint();

    const displayName = await ensureDisplayName({ required: true });
    if (!displayName) return;

    busy = true;
    btn.disabled = true;

    const optimistic = computeOptimisticReaction({
      counts,
      mine: myMood,
      micMine: myMic,
      kind,
    });
    if (optimistic) {
      paint({
        ...optimistic.counts,
        mine: optimistic.mine,
        micMine: optimistic.micMine,
      });
    }

    try {
      const meta = getNowPlayingMeta() || {};
      const res = await fetchFn("/api/reactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          kind,
          guestId: getReactGuestId(),
          by: guestBadgeName() || displayName,
          name: meta.title || "",
          artist: meta.artist || "",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not react.");
      syncedFor = id;
      paint(data);
      if (kind === "mic") {
        showToast(
          data.micMine
            ? "Added to the Karaoke List"
            : "Removed from the Karaoke List"
        );
      }
      if (getCurrentView() === "stats") void loadStats();
    } catch (err) {
      syncedFor = null;
      void syncMyReactions(id);
      showToast(err.message || "Could not react.", true);
    } finally {
      btn.disabled = false;
      busy = false;
    }
  });

  clearReactionsBtn?.addEventListener("click", async () => {
    const ok = await confirmModal(
      "Reset reactions? Clears Now Playing mood reactions. Karaoke mic tags stay.",
      "Reset reactions"
    );
    if (!ok) return;
    clearReactionsBtn.disabled = true;
    try {
      const res = await hostFetch("/api/settings/clear-reactions", {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not clear reactions.");
      showToast("Mood reactions cleared");
      invalidateAndResync();
      if (getCurrentView() === "stats") void loadStats();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      clearReactionsBtn.disabled = false;
    }
  });

  clearKaraokeBtn?.addEventListener("click", async () => {
    const ok = await confirmModal(
      "Reset Karaoke list? Clears mic tags. Mood reactions stay.",
      "Reset Karaoke list"
    );
    if (!ok) return;
    clearKaraokeBtn.disabled = true;
    try {
      const res = await hostFetch("/api/settings/clear-karaoke", {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not clear Karaoke list.");
      showToast("Karaoke list cleared");
      invalidateAndResync();
      if (getCurrentView() === "stats") void loadStats();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      clearKaraokeBtn.disabled = false;
    }
  });

  return {
    paint,
    syncMyReactions,
    noteTrackChange,
    applyFromNowPlaying,
    setDisplayHidden,
    invalidateAndResync,
    getSyncedFor,
  };
}
