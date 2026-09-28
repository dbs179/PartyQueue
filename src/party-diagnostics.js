// Party-night snapshot for /api/ready. Reads memory, counters, and the last
// cached Sonos/Spotify state. It must not start a SOAP call or a Spotify
// request — health checks run on a timer and must not add speaker load.

import { recentFailures, lastSuccessFor } from "./failure-log.js";
import { getSonosManagerHealth } from "./sonos-manager-health.js";
import { listManagedSonosDevices } from "./sonos-core.js";
import {
  listSpeakerHealth,
  observeKnownSpeakers,
} from "./sonos-speaker-health.js";
import { getNowPlaying, getQueueList } from "./sonos-snapshots.js";
import { getSonosTargetRoom } from "./settings.js";
import {
  isUserConnected,
  spotifyCooldownMs,
  spotifyUnavailableMs,
} from "./spotify.js";
import { getSpotifyAppStatus } from "./spotify-app.js";
import { nowPlayingMonitor, nowPlayingStreamClientCount } from "./now-playing-http.js";
import { queueStreamClientCount } from "./queue-http.js";
import { partyStreamClientCount } from "./party-settings-http.js";

function peekValue(reader) {
  try {
    return reader.peek?.() || null;
  } catch {
    return null;
  }
}

/** Per-speaker responsiveness. Never starts discovery or a SOAP call. */
function sonosSpeakerHealth() {
  try {
    observeKnownSpeakers(listManagedSonosDevices());
  } catch {
    /* diagnostics must still return */
  }
  return listSpeakerHealth();
}

/**
 * Diagnostics safe to return on the LAN. No tokens, secrets, or guest names
 * beyond the track that is already on the Now Playing screen.
 */
export function collectPartyDiagnostics() {
  const mem = process.memoryUsage();
  const np = peekValue(getNowPlaying);
  const queue = peekValue(getQueueList);
  const tracks = Array.isArray(queue?.value) ? queue.value : null;
  const sonosHealth = getSonosManagerHealth();
  const monitor = nowPlayingMonitor?.health || {};
  const current = np?.value && typeof np.value === "object" ? np.value : null;

  return {
    uptimeSec: Math.round(process.uptime()),
    memoryMb: {
      rss: Math.round(mem.rss / (1024 * 1024)),
      heapUsed: Math.round(mem.heapUsed / (1024 * 1024)),
    },
    sse: {
      nowPlaying: nowPlayingStreamClientCount(),
      queue: queueStreamClientCount(),
      party: partyStreamClientCount(),
    },
    spotify: {
      configured: !!getSpotifyAppStatus().configured,
      userConnected: isUserConnected(),
      cooldownMs: spotifyCooldownMs(),
      unavailableMs: spotifyUnavailableMs(),
      lastSuccessAt: lastSuccessFor("spotify"),
    },
    sonos: {
      status: monitor.status || "unknown",
      room: current?.room || getSonosTargetRoom() || null,
      lastSuccessAt: sonosHealth.lastSuccessAt || 0,
      unhealthySince: sonosHealth.unhealthySince || 0,
      lastResetAt: sonosHealth.lastResetAt || 0,
      speakers: sonosSpeakerHealth(),
    },
    queue: {
      upcoming: tracks ? tracks.length : null,
      fresh: !!queue?.fresh,
      currentTitle: current?.title || null,
      currentArtist: current?.artist || null,
    },
    recentFailures: recentFailures(),
  };
}
