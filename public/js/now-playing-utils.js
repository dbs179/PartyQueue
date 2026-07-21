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

export function serverPlaybackPosition(np, maxAgeSec = 10) {
  const position = Number(np?.positionSec);
  if (!Number.isFinite(position)) return null;
  const playing = !!(np?.isPlaying && !np?.djVoice && !np?.metadataPending);
  const age = Number(np?.positionAgeSec);
  return (
    position +
    (playing && Number.isFinite(age)
      ? Math.max(0, Math.min(maxAgeSec, age))
      : 0)
  );
}
