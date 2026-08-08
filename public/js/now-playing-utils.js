export function mediaIdentity(np) {
  if (!np) return "";
  const uri = String(np.uri || "").trim();
  const duration = Number.isFinite(Number(np.durationSec))
    ? Math.round(Number(np.durationSec))
    : "";
  if (uri) return `${uri}|${duration}`;
  return [
    String(np.title || "").trim().toLowerCase(),
    String(np.artist || "").trim().toLowerCase(),
    String(np.album || "").trim().toLowerCase(),
    duration,
  ].join("|");
}

export function playbackIdentity(np) {
  if (!np) return "";
  return `${Number(np.queueTrack) || 0}|${mediaIdentity(np)}`;
}

function parseTimestamp(token) {
  const match = String(token).match(/^(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?$/);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  if (seconds >= 60) return null;
  const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
  return minutes * 60 + seconds + fraction;
}

export function parseSyncedLyrics(raw) {
  if (!raw) return null;
  const lines = [];
  for (const row of String(raw).split(/\r?\n/)) {
    const tags = [...row.matchAll(/\[(\d{1,3}:\d{2}(?:[.:]\d{1,3})?)\]/g)];
    if (!tags.length) continue;
    const text = row
      .replace(/^(?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+\s*/, "")
      .replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, "")
      .trim();
    if (!text) continue;
    for (const tag of tags) {
      const t = parseTimestamp(tag[1]);
      if (t != null) lines.push({ t, text });
    }
  }
  lines.sort((a, b) => a.t - b.t);
  return lines.length ? lines : null;
}

/**
 * Advance a Sonos position anchor by server-computed snapshot age.
 * Display models should already strip transition pending flags; callers that
 * still pass transport snapshots can opt into advancing during pending.
 */
export function serverPlaybackPosition(np, maxAgeSec = 10) {
  const position = Number(np?.positionSec);
  if (!Number.isFinite(position)) return null;
  const playing = !!(np?.isPlaying && !np?.djVoice);
  const age = Number(np?.positionAgeSec);
  return (
    position +
    (playing && Number.isFinite(age)
      ? Math.max(0, Math.min(maxAgeSec, age))
      : 0)
  );
}

/** Build a Now Playing-shaped object from a queue list row (optimistic skip). */
export function queueTrackAsNowPlaying(track, extras = {}) {
  if (!track) return null;
  const origin =
    typeof track.origin === "string"
      ? track.origin
      : track.searched
        ? "searched"
        : track.discovered
          ? "discovered"
          : track.moodPick
            ? "mood"
            : null;
  return {
    title: track.title || "",
    artist: track.artist || "",
    album: track.album || "",
    albumArt: track.albumArt || null,
    uri: track.uri || null,
    djVoice: !!track.djVoice,
    positionSec: 0,
    positionAgeSec: 0,
    durationSec: Number.isFinite(Number(track.durationSec))
      ? Number(track.durationSec)
      : null,
    isPlaying: true,
    queuePlaying: true,
    queueTrack: Number(track.position) || 0,
    metadataPending: false,
    optimistic: true,
    // Keep queue origin so the NP pill can show Requested/Discover/Random
    // immediately instead of flashing grey "Updating" with no origin.
    origin,
    searched: !!track.searched,
    discovered: !!track.discovered,
    moodPick: !!track.moodPick,
    mood: track.mood || null,
    requestedBy: track.requestedBy || "",
    dedication: track.dedication || "",
    genreLane: track.genreLane || null,
    reactions: {},
    ...extras,
  };
}

/**
 * Choose what the UI paints. Never blank art for Sonos metadata lag — keep the
 * last confirmed track or an optimistic next-queue row until transport confirms.
 */
export function resolveNowPlayingDisplay({
  transport = null,
  lastConfirmed = null,
  optimistic = null,
} = {}) {
  if (!transport && !lastConfirmed && !optimistic) {
    return { display: null, mode: "empty", confirmed: null };
  }

  const transportMedia = mediaIdentity(transport);
  const optimisticMedia = mediaIdentity(optimistic);
  const confirmedMedia = mediaIdentity(lastConfirmed);

  if (optimistic && (optimistic.title || optimistic.artist || optimistic.albumArt)) {
    const transportMatchesOptimistic =
      !!transportMedia && !!optimisticMedia && transportMedia === optimisticMedia;
    if (transportMatchesOptimistic && !transport.metadataPending) {
      return {
        display: { ...transport, metadataPending: false, updating: false },
        mode: "confirmed",
        confirmed: transport,
      };
    }

    const transportStillPrior =
      !transport ||
      !!transport.metadataPending ||
      !transportMedia ||
      (!!confirmedMedia && transportMedia === confirmedMedia);

    if (transportStillPrior) {
      return {
        display: {
          ...optimistic,
          metadataPending: false,
          updating: true,
          optimistic: true,
          muted: transport?.muted,
          shuffle: transport?.shuffle,
          state: transport?.state,
          room: transport?.room ?? optimistic.room,
          isPlaying: transport?.isPlaying ?? true,
          queuePlaying: transport?.queuePlaying ?? true,
        },
        mode: "optimistic",
        confirmed: lastConfirmed,
      };
    }

    // Sonos landed on a different confirmed track than the optimistic guess.
    return {
      display: { ...transport, metadataPending: false, updating: false },
      mode: "confirmed",
      confirmed: transport,
    };
  }

  if (transport && !transport.metadataPending) {
    return {
      display: { ...transport, metadataPending: false, updating: false },
      mode: "confirmed",
      confirmed: transport,
    };
  }

  if (lastConfirmed && (lastConfirmed.title || lastConfirmed.artist || lastConfirmed.albumArt)) {
    return {
      display: {
        ...lastConfirmed,
        metadataPending: false,
        updating: true,
        muted: transport?.muted ?? lastConfirmed.muted,
        shuffle: transport?.shuffle ?? lastConfirmed.shuffle,
        isPlaying: transport?.isPlaying ?? lastConfirmed.isPlaying,
        queuePlaying: transport?.queuePlaying ?? lastConfirmed.queuePlaying,
        state: transport?.state ?? lastConfirmed.state,
        // Keep the local playhead advancing from the confirmed anchor.
        positionSec: lastConfirmed.positionSec,
        positionAgeSec: lastConfirmed.positionAgeSec,
        durationSec: lastConfirmed.durationSec,
      },
      mode: "converging",
      confirmed: lastConfirmed,
    };
  }

  // First paint mid-transition with no history: keep Sonos fields visible.
  if (transport) {
    return {
      display: { ...transport, metadataPending: false, updating: true },
      mode: "converging",
      confirmed: null,
    };
  }

  return { display: null, mode: "empty", confirmed: null };
}
