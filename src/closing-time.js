// Last-call / end-of-night song matcher.
//
// Default (no custom URI configured): "Closing Time" by Semisonic — title must
// match exactly and artist must include "Semisonic" so Tom Waits / Leonard
// Cohen covers don't end the party.
//
// Custom: host picks a Spotify track under DJ → Last call; we match primarily
// by track id, with name+artist as a fallback.

import {
  DEFAULT_END_OF_NIGHT,
  getDjVoiceSettings,
  loadSettings,
} from "./settings.js";

function trackIdFromUri(uri) {
  if (!uri) return null;
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    /* leave as-is */
  }
  const match = decoded.match(/spotify:track:([A-Za-z0-9]+)/i);
  return match ? match[1] : null;
}

/**
 * Lightweight end-of-night fields for hot match paths (Random sampling).
 * Avoids getDjVoiceSettings() — that runs DJ-icon seeding/migrations and is
 * far too heavy to call once per track while scanning the playlist pool.
 */
function endOfNightMatchConfig(dj = null) {
  if (dj && typeof dj === "object") {
    return {
      endOfNightTrackUri: dj.endOfNightTrackUri || null,
      endOfNightTrackName: dj.endOfNightTrackName || null,
      endOfNightTrackArtist: dj.endOfNightTrackArtist || null,
    };
  }
  const s = loadSettings();
  return {
    endOfNightTrackUri: s.endOfNightTrackUri || null,
    endOfNightTrackName: s.endOfNightTrackName || null,
    endOfNightTrackArtist: s.endOfNightTrackArtist || null,
  };
}

/**
 * Effective end-of-night song for display / scripts.
 * @returns {{ uri: string|null, name: string, artist: string, isDefault: boolean }}
 */
export function getEndOfNightTrack(dj = null) {
  const s = endOfNightMatchConfig(dj);
  const uri = s.endOfNightTrackUri || null;
  if (uri) {
    return {
      uri,
      name: s.endOfNightTrackName || "Last call song",
      artist: s.endOfNightTrackArtist || "",
      isDefault: false,
    };
  }
  return {
    uri: null,
    name: DEFAULT_END_OF_NIGHT.name,
    artist: DEFAULT_END_OF_NIGHT.artist,
    isDefault: true,
  };
}

function titlesMatch(a, b) {
  return (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();
}

function artistIncludes(haystack, needle) {
  return (haystack || "").toLowerCase().includes((needle || "").toLowerCase());
}

/**
 * @param {{ uri?: string|null, name?: string|null, artist?: string|null }} track
 * @param {ReturnType<typeof getDjVoiceSettings>|null} [dj]
 */
export function isEndOfNightTrack(track = {}, dj = null) {
  const s = endOfNightMatchConfig(dj);
  const configuredUri = s.endOfNightTrackUri || null;
  const trackId = trackIdFromUri(track.uri);
  const configuredId = trackIdFromUri(configuredUri);

  if (configuredId) {
    if (trackId && trackId === configuredId) return true;
    // Fallback: same title + artist contains configured artist.
    const wantName = s.endOfNightTrackName;
    const wantArtist = s.endOfNightTrackArtist;
    if (
      wantName &&
      wantArtist &&
      titlesMatch(track.name, wantName) &&
      artistIncludes(track.artist, wantArtist)
    ) {
      return true;
    }
    return false;
  }

  // Built-in Closing Time (Semisonic).
  return (
    titlesMatch(track.name, DEFAULT_END_OF_NIGHT.name) &&
    artistIncludes(track.artist, DEFAULT_END_OF_NIGHT.artist)
  );
}

/** @deprecated Prefer isEndOfNightTrack({ name, artist }). Kept for call sites. */
export function isClosingTime(name, artist, uri = null) {
  return isEndOfNightTrack({ name, artist, uri });
}

/** Whether last-call should insert spoken Party Summary TTS. */
export function shouldAnnouncePartyRecap(dj = null) {
  const s = dj || getDjVoiceSettings();
  return s.djPartyRecapEnabled !== false;
}
