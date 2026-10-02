import { envTimeoutMs, withTimeout } from "./with-timeout.js";
import { isSonosUnreachableError } from "./sonos-reachability.js";
import {
  noteSpeakerHealthFailure,
  noteSpeakerHealthSuccess,
} from "./sonos-speaker-health.js";

/**
 * Per-speaker announcement volume.
 *
 * One lane per speaker, shared by every announcement. A lane holds at most
 * one SetVolume. A newer desired level replaces anything not yet sent, and
 * the call already on the wire is never overlapped. These writes do not take
 * the transport lane and do not touch the reachability skip map.
 */

const PLAYER_VOLUME_TIMEOUT_MS = envTimeoutMs(
  "PARTYQUEUE_PLAYER_VOLUME_TIMEOUT_MS",
  2_000
);

/** Owning driver may spend this long finishing in-flight work and one correction. */
export const SPEAKER_VOLUME_CLEANUP_MS = 4_500;

/** @type {Map<string, SpeakerLane>} */
const lanes = new Map();

/**
 * @typedef {{
 *   key: string,
 *   speaker: object,
 *   ownerEpoch: number,
 *   desired: number|null,
 *   inFlight: boolean,
 *   inFlightLevel: number|null,
 *   inFlightEpoch: number,
 *   lastResolvedLevel: number|null,
 *   lastAttemptedLevel: number|null,
 *   followUpSpentFor: number|null,
 *   pendingFollowUp: boolean,
 *   lastTimedOut: boolean,
 *   closedEpoch: number,
 *   forceOnce: boolean,
 *   verified: boolean,
 * }} SpeakerLane
 */

function clampVolume(level) {
  return Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
}

/** Same identity order as speaker health and the reachability skip map. */
export function speakerVolumeKey(speaker) {
  return String(speaker?.Host || speaker?.Uuid || speaker?.Name || "");
}

function blankLane(key, speaker) {
  return {
    key,
    speaker,
    ownerEpoch: 0,
    desired: null,
    inFlight: false,
    inFlightLevel: null,
    inFlightEpoch: 0,
    lastResolvedLevel: null,
    lastAttemptedLevel: null,
    followUpSpentFor: null,
    pendingFollowUp: false,
    lastTimedOut: false,
    closedEpoch: 0,
    forceOnce: false,
    verified: false,
  };
}

function laneFor(speaker) {
  const key = speakerVolumeKey(speaker);
  if (!key) return null;
  let lane = lanes.get(key);
  if (!lane) {
    lane = blankLane(key, speaker);
    lanes.set(key, lane);
  }
  lane.speaker = speaker;
  return lane;
}

function needsSend(lane) {
  if (lane.closedEpoch === lane.ownerEpoch && lane.ownerEpoch !== 0) return false;
  if (lane.desired == null) return false;
  if (lane.forceOnce || lane.pendingFollowUp) return true;
  if (lane.desired === lane.lastResolvedLevel) return false;
  if (lane.lastAttemptedLevel === lane.desired) return false;
  return true;
}

async function writeVolume(speaker, level) {
  if (typeof speaker?.setVolume === "function") {
    await speaker.setVolume(level);
    return;
  }
  const device = speaker?.device || speaker;
  await withTimeout(
    device.RenderingControlService.SetVolume({
      InstanceID: 0,
      Channel: "Master",
      DesiredVolume: level,
    }),
    PLAYER_VOLUME_TIMEOUT_MS,
    "Sonos volume write timed out"
  );
}

async function readVolume(speaker) {
  if (typeof speaker?.getVolume === "function") {
    return clampVolume(await speaker.getVolume());
  }
  const device = speaker?.device || speaker;
  const read = await withTimeout(
    device.RenderingControlService.GetVolume({
      InstanceID: 0,
      Channel: "Master",
    }),
    PLAYER_VOLUME_TIMEOUT_MS,
    "Sonos volume read timed out"
  );
  return clampVolume(read?.CurrentVolume);
}

function kick(lane) {
  if (lane.inFlight || !needsSend(lane)) return;
  const level = lane.desired;
  const epoch = lane.ownerEpoch;
  lane.inFlight = true;
  lane.inFlightLevel = level;
  lane.inFlightEpoch = epoch;
  if (lane.pendingFollowUp) {
    lane.pendingFollowUp = false;
    lane.followUpSpentFor = level;
  }
  if (lane.forceOnce) lane.forceOnce = false;
  lane.lastAttemptedLevel = level;
  const started = Date.now();
  // Start the SOAP now. publish() still returns before it settles.
  Promise.resolve(writeVolume(lane.speaker, level)).then(
    () => settle(lane, { ok: true, level, epoch, started }),
    (err) => settle(lane, { ok: false, err, level, epoch, started })
  );
}

function settle(lane, result) {
  if (!lane.inFlight || lane.inFlightLevel !== result.level) return;
  lane.inFlight = false;
  const latencyMs = Math.max(0, Date.now() - result.started);
  const commFailure = !result.ok && isSonosUnreachableError(result.err);
  if (result.ok) {
    lane.lastResolvedLevel = result.level;
    lane.lastTimedOut = false;
    noteSpeakerHealthSuccess(lane.speaker, { latencyMs });
  } else if (commFailure) {
    lane.lastTimedOut = true;
    noteSpeakerHealthFailure(lane.speaker, result.err, { latencyMs });
  } else if (lane.desired === result.level) {
    lane.followUpSpentFor = result.level;
  }
  if (lane.closedEpoch === lane.ownerEpoch && lane.ownerEpoch !== 0) return;
  if (commFailure && lane.desired === result.level) {
    if (lane.followUpSpentFor !== lane.desired) {
      lane.pendingFollowUp = true;
      kick(lane);
    }
    return;
  }
  kick(lane);
}

/**
 * Remember the newest level for this announcement. Returns immediately.
 * An older epoch cannot publish over a newer one, and a closed epoch cannot
 * start another write.
 * @param {object} speaker
 * @param {number} level
 * @param {number} epoch
 */
export function publishSpeakerVolume(speaker, level, epoch) {
  const lane = laneFor(speaker);
  if (!lane) return;
  const owner = Number(epoch) || 0;
  if (owner < lane.ownerEpoch) return;
  if (owner === lane.closedEpoch) return;
  if (owner > lane.ownerEpoch) {
    lane.ownerEpoch = owner;
    lane.followUpSpentFor = null;
    lane.pendingFollowUp = false;
    lane.lastAttemptedLevel = null;
    lane.verified = false;
  }
  const next = clampVolume(level);
  if (lane.desired !== next) {
    lane.desired = next;
    lane.followUpSpentFor = null;
    lane.pendingFollowUp = false;
    lane.lastAttemptedLevel = null;
    lane.verified = false;
  }
  kick(lane);
}

/**
 * Let in-flight calls finish, send the current desired level if it is still
 * owed, and — only when the last call timed out and time remains — read back
 * once and correct once.
 * @param {number} epoch
 * @param {{ budgetMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void> }} [opts]
 */
export async function flushSpeakerVolumeEpoch(epoch, opts = {}) {
  const now = opts.now || Date.now;
  const sleep =
    opts.sleep ||
    ((ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (typeof timer.unref === "function") timer.unref();
      }));
  const budgetMs = opts.budgetMs ?? SPEAKER_VOLUME_CLEANUP_MS;
  const started = now();
  const deadline = started + budgetMs;
  const mine = () =>
    [...lanes.values()].filter((lane) => lane.ownerEpoch === epoch);

  while (now() < deadline) {
    let pending = false;
    for (const lane of mine()) {
      if (lane.inFlight) pending = true;
      else if (needsSend(lane)) {
        kick(lane);
        if (lane.inFlight) pending = true;
      }
    }
    if (!pending) break;
    const remain = deadline - now();
    if (remain <= 0) break;
    const before = now();
    await sleep(Math.min(30, remain));
    if (now() <= before) break;
  }

  for (const lane of mine()) {
    if (now() >= deadline) break;
    if (lane.inFlight || lane.verified || !lane.lastTimedOut) continue;
    if (lane.desired == null || lane.desired === lane.lastResolvedLevel) continue;
    lane.verified = true;
    const readStarted = Date.now();
    try {
      const got = await readVolume(lane.speaker);
      noteSpeakerHealthSuccess(lane.speaker, {
        latencyMs: Math.max(0, Date.now() - readStarted),
      });
      if (got !== lane.desired && now() < deadline && !lane.inFlight) {
        lane.forceOnce = true;
        kick(lane);
        let spins = 0;
        while (lane.inFlight && now() < deadline && spins < 20) {
          spins += 1;
          const left = deadline - now();
          if (left <= 0) break;
          await sleep(Math.min(30, left));
        }
      }
    } catch (err) {
      if (isSonosUnreachableError(err)) {
        noteSpeakerHealthFailure(lane.speaker, err, {
          latencyMs: Math.max(0, Date.now() - readStarted),
        });
      }
    }
  }

  for (const lane of mine()) {
    if (lane.ownerEpoch === epoch) lane.closedEpoch = epoch;
  }
}

/** @returns {SpeakerLane|null} */
export function speakerVolumeLaneForTests(speaker) {
  const key = typeof speaker === "string" ? speaker : speakerVolumeKey(speaker);
  const lane = lanes.get(key);
  if (!lane) return null;
  return { ...lane };
}

export function resetSpeakerVolumeForTests() {
  lanes.clear();
}
