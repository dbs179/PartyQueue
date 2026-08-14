/**
 * Next automatic special set (Same Artist / Most Loved / Most Hated).
 * Only flavors that are enabled and can fill a set are candidates. When more
 * than one is equally soon, one is reserved at random and shown until it
 * plays or it drops out of the tie.
 */

import { getRandomnessSettings, getContentSettings } from "./settings.js";
import {
  reactionSetPoolReady,
  reactionSetSetsUntil,
} from "./reaction-sets.js";
import {
  sameArtistSetsUntil,
  sameArtistPoolReady,
  getSetsSinceLastSameArtistBatch,
} from "./same-artist-batch.js";
import { peekCachedPlaylists } from "./spotify.js";

const KIND_LABELS = {
  loved: "Most Loved Set",
  hated: "Most Hated Set",
  sameArtist: "Same Artist Set",
};

/** @type {{ kind: string, setsUntil: number }|null} */
let reserved = null;

export function specialSetLabel(kind) {
  return KIND_LABELS[kind] || null;
}

export function resetSpecialSetReservationForTests() {
  reserved = null;
}

function sameArtistMinTracks(setSize) {
  const n = Math.max(1, Math.floor(Number(setSize) || 5));
  return Math.min(3, Math.max(2, n));
}

/**
 * @param {{
 *   setSize?: number,
 *   playlistIds?: string[]|null,
 *   genres?: string[]|null,
 *   mood?: string|null,
 *   filterExplicit?: boolean,
 *   playlists?: object[],
 *   settings?: object,
 * }} [opts]
 */
export function listSpecialSetCandidates(opts = {}) {
  const cfg = opts.settings || getRandomnessSettings();
  const setSize = Math.max(1, Math.floor(Number(opts.setSize) || cfg.endlessQueueCount || 5));
  const filterExplicit =
    opts.filterExplicit != null
      ? !!opts.filterExplicit
      : !!getContentSettings().filterExplicit;
  const playlists = Array.isArray(opts.playlists)
    ? opts.playlists
    : peekCachedPlaylists();
  const readyOverride =
    opts.poolReady && typeof opts.poolReady === "object" ? opts.poolReady : null;

  const lovedUntil = reactionSetSetsUntil("loved", cfg);
  const hatedUntil = reactionSetSetsUntil("hated", cfg);
  const sameUntilLive = sameArtistSetsUntil({
    enabled: !!cfg.sameArtistBatchEnabled,
    everyN: cfg.sameArtistBatchEveryN,
    setsSince: getSetsSinceLastSameArtistBatch(),
  });

  return [
    {
      kind: "loved",
      label: KIND_LABELS.loved,
      enabled: !!cfg.lovedReactionSetEnabled,
      poolReady:
        readyOverride && "loved" in readyOverride
          ? !!readyOverride.loved
          : reactionSetPoolReady("loved", setSize),
      setsUntil: lovedUntil,
    },
    {
      kind: "hated",
      label: KIND_LABELS.hated,
      enabled: !!cfg.hatedReactionSetEnabled,
      poolReady:
        readyOverride && "hated" in readyOverride
          ? !!readyOverride.hated
          : reactionSetPoolReady("hated", setSize),
      setsUntil: hatedUntil,
    },
    {
      kind: "sameArtist",
      label: KIND_LABELS.sameArtist,
      enabled: !!cfg.sameArtistBatchEnabled,
      poolReady:
        readyOverride && "sameArtist" in readyOverride
          ? !!readyOverride.sameArtist
          : sameArtistPoolReady(playlists, {
              minTracks: sameArtistMinTracks(setSize),
              playlistIds: opts.playlistIds,
              genres: opts.genres,
              mood: opts.mood,
              filterExplicit,
            }),
      setsUntil: sameUntilLive,
    },
  ].map((row) => ({
    ...row,
    eligible: !!(
      row.enabled &&
      row.poolReady &&
      row.setsUntil != null &&
      Number.isFinite(row.setsUntil)
    ),
  }));
}

/**
 * @param {{
 *   setSize?: number,
 *   playlistIds?: string[]|null,
 *   genres?: string[]|null,
 *   mood?: string|null,
 *   filterExplicit?: boolean,
 *   playlists?: object[],
 *   settings?: object,
 *   random?: () => number,
 * }} [opts]
 * @returns {{ kind: string, label: string, setsUntil: number }|null}
 */
export function pickNextSpecialSet(opts = {}) {
  const eligible = listSpecialSetCandidates(opts).filter((row) => row.eligible);
  if (!eligible.length) {
    reserved = null;
    return null;
  }
  const min = Math.min(...eligible.map((row) => row.setsUntil));
  const tied = eligible.filter((row) => row.setsUntil === min);
  if (reserved && tied.some((row) => row.kind === reserved.kind)) {
    const keep = tied.find((row) => row.kind === reserved.kind);
    reserved = { kind: keep.kind, setsUntil: keep.setsUntil };
    return {
      kind: keep.kind,
      label: keep.label,
      setsUntil: keep.setsUntil,
    };
  }
  const random = typeof opts.random === "function" ? opts.random : Math.random;
  const index = Math.min(
    tied.length - 1,
    Math.max(0, Math.floor(random() * tied.length))
  );
  const pick = tied[index];
  reserved = { kind: pick.kind, setsUntil: pick.setsUntil };
  return {
    kind: pick.kind,
    label: pick.label,
    setsUntil: pick.setsUntil,
  };
}

export function getNextSpecialSetState(opts = {}) {
  const next = pickNextSpecialSet(opts);
  if (!next) {
    return { kind: null, label: null, setsUntil: null };
  }
  return next;
}

export function clearSpecialSetReservation() {
  reserved = null;
}
