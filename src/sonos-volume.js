import { withSonosTransportLane } from "./sonos-lock.js";
import { getManager, resolveGroup } from "./sonos-core.js";
import { invalidateSonosSnapshots } from "./sonos-snapshots.js";
import {
  isDjVolumeHandoffActive,
  isDjVolumeHandoffArmed,
} from "./dj-volume-handoff-state.js";
import { envTimeoutMs, withTimeout } from "./with-timeout.js";
import {
  liveMembers,
  markPlayerReachable,
  noteSpeakerFailure,
  resetSpeakerReachabilityForTests,
  setSkipUnreachableMsForTests,
} from "./sonos-reachability.js";

const VOLUME_STEP = 1;
const PLAYER_VOLUME_TIMEOUT_MS = envTimeoutMs(
  "PARTYQUEUE_PLAYER_VOLUME_TIMEOUT_MS",
  2_000
);

let playerVolumeTimeoutMs = PLAYER_VOLUME_TIMEOUT_MS;

export function setPlayerVolumeTimeoutForTests(ms) {
  if (ms != null) playerVolumeTimeoutMs = Number(ms);
}
export { setSkipUnreachableMsForTests };
let volumeIo = {};

/** Inject fakes for tests. Call with {} to restore the real speaker layer. */
export function configureVolumeIo(next = {}) {
  volumeIo = next || {};
}

async function groupMembers() {
  if (typeof volumeIo.resolveMembers === "function") {
    return volumeIo.resolveMembers();
  }
  const m = await (volumeIo.getManager || getManager)();
  const { members } = await (volumeIo.resolveGroup || resolveGroup)(m);
  return members;
}

export function resetVolumeReachabilityForTests() {
  playerVolumeTimeoutMs = PLAYER_VOLUME_TIMEOUT_MS;
  resetSpeakerReachabilityForTests();
  cachedGroupVolume = null;
  seedRetryMs = VOLUME_SEED_RETRY_MS;
  seedNextAttemptAt = 0;
  seedRead = null;
  volumeIo = {};
}

/** Last commanded/read group volume (0–100), or null. */
let cachedGroupVolume = null;

/**
 * A seed attempt that found no answer waits this long before trying again, so
 * a room that is off at startup cannot be re-read on every screen's poll.
 */
const VOLUME_SEED_RETRY_MS = envTimeoutMs(
  "PARTYQUEUE_VOLUME_SEED_RETRY_MS",
  60_000
);

let seedRetryMs = VOLUME_SEED_RETRY_MS;
let seedNextAttemptAt = 0;
let seedRead = null;

export function setVolumeSeedRetryForTests(ms) {
  if (ms != null) seedRetryMs = Number(ms);
}

export function noteGroupVolume(level) {
  const n = Math.round(Number(level));
  if (!Number.isFinite(n)) return;
  cachedGroupVolume = Math.max(0, Math.min(100, n));
}

export function getCachedGroupVolume() {
  return cachedGroupVolume;
}

/**
 * Learn the room's level ONCE, so a server that has just started can paint the
 * header before the first volume press. Every later change comes through
 * PartyQueue and lands in `cachedGroupVolume`, so this never reads on a clock
 * — a known level short-circuits immediately and concurrent screens share the
 * single in-flight read. An announce publishes its own commanded levels, so
 * skip it while one is armed: a sample taken mid-shout would cache the boost
 * as the room's level.
 */
export async function seedGroupVolumeForDisplay() {
  if (cachedGroupVolume != null) return cachedGroupVolume;
  if (isDjVolumeHandoffActive() || isDjVolumeHandoffArmed()) return null;
  if (Date.now() < seedNextAttemptAt) return null;
  if (!seedRead) {
    seedRead = getGroupVolume()
      .catch(() => null)
      .finally(() => {
        seedNextAttemptAt = Date.now() + seedRetryMs;
        seedRead = null;
      });
  }
  return seedRead;
}

/**
 * Prefer the DJ handoff's commanded level while a ramp is active so the PC
 * Volume header can tick without extra Sonos SOAP.
 */
export function resolveVolumeForDisplay({ handoff = null, cached = null } = {}) {
  const phase = String(handoff?.phase || "idle");
  const active =
    phase !== "idle" &&
    phase !== "complete" &&
    phase !== "cancelled" &&
    phase !== "deferred";
  const commanded = Number(handoff?.currentVolume);
  const ramping = active && !!handoff?.volumeLocked;
  if (active && Number.isFinite(commanded)) {
    return {
      volume: Math.max(0, Math.min(100, Math.round(commanded))),
      ramping,
      phase,
    };
  }
  if (cached != null && Number.isFinite(Number(cached))) {
    return {
      volume: Math.max(0, Math.min(100, Math.round(Number(cached)))),
      ramping: false,
      phase: active ? phase : "idle",
    };
  }
  return null;
}

/**
 * GET /api/volume. Memory only — the level is whatever PartyQueue last set or
 * seeded, never a fresh Sonos read.
 */
export function volumeGetPayload(handoff = null) {
  const fromMemory = resolveVolumeForDisplay({
    handoff,
    cached: cachedGroupVolume,
  });
  if (fromMemory?.ramping) return { ok: true, ...fromMemory };
  if (fromMemory?.volume != null) {
    return { ok: true, volume: fromMemory.volume, ramping: false };
  }
  return { ok: true, volume: null, ramping: false };
}

export function assertManualVolumeAvailable() {
  if (!isDjVolumeHandoffActive()) return;
  const error = new Error(
    "DJ volume handoff in progress — volume will return automatically."
  );
  error.statusCode = 423;
  throw error;
}

// Pick the canonical "current" level for the group: the most common per-player
// volume (the mode). Ties are broken in favor of the coordinator's level. This
// is what makes an out-of-sync speaker snap to where the rest already are.
// Step the whole group by `delta` while keeping every player LOCKED to one
// shared absolute level. We read each player's own volume, take the HIGHEST as
// the reference, then SET every player to reference + delta. Using absolute
// per-player SetVolume avoids two Sonos quirks: group volume scales each
// speaker proportionally (so they drift apart), and SetRelativeGroupVolume
// silently ignores small positive steps.
const readPlayerVolume = (device) =>
  device.RenderingControlService.GetVolume({
    InstanceID: 0,
    Channel: "Master",
  }).then((r) => r.CurrentVolume);

const setPlayerVolume = (device, volume) =>
  device.RenderingControlService.SetVolume({
    InstanceID: 0,
    Channel: "Master",
    DesiredVolume: volume,
  });

async function readPlayerVolumeSafe(device) {
  try {
    const volume = Number(
      await withTimeout(
        readPlayerVolume(device),
        playerVolumeTimeoutMs,
        "Sonos volume read timed out"
      )
    );
    markPlayerReachable(device);
    return { device, volume, ok: true };
  } catch (err) {
    noteSpeakerFailure(device, err);
    return { device, volume: null, ok: false };
  }
}

async function setPlayerVolumeSafe(device, volume) {
  try {
    await withTimeout(
      setPlayerVolume(device, volume),
      playerVolumeTimeoutMs,
      "Sonos volume write timed out"
    );
    markPlayerReachable(device);
    return true;
  } catch (err) {
    noteSpeakerFailure(device, err);
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How long to wait for speakers to finish ramping before re-checking, and how
// many correction passes to attempt. Sonos ramps volume over a few hundred ms
// and, within a group, setting one speaker can briefly tug the others (relative
// group-volume coupling). Re-asserting the absolute target after a short settle
// makes the whole group converge to one exact level.
const SETTLE_MS = 350;
const MAX_PASSES = 4;

export { sleep, SETTLE_MS };

// Set every member to one absolute target, then settle + verify in a short
// loop, re-asserting the target on any player that hasn't landed on it yet.
// This guarantees the whole group ends locked to the same exact level.
/** Prefer live members. If a topology timeout skipped the whole group, still
 *  talk to those speakers — a slow GetZoneGroupState is not a dead player. */
function volumeTargets(members) {
  const live = liveMembers(members);
  if (live.length) return live;
  return Array.isArray(members) ? members.filter(Boolean) : [];
}

export async function lockGroupVolume(members, target) {
  const want = Math.max(0, Math.min(100, Math.round(Number(target) || 0)));
  let active = volumeTargets(members);
  if (!active.length) {
    throw new Error("No reachable Sonos players for group volume.");
  }
  let toSet = active;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    if (!toSet.length) break;
    await Promise.all(toSet.map((device) => setPlayerVolumeSafe(device, want)));
    active = liveMembers(active);
    await sleep(SETTLE_MS);

    const after = await Promise.all(active.map((device) => readPlayerVolumeSafe(device)));
    active = after.filter((r) => r.ok).map((r) => r.device);
    toSet = after.filter((r) => r.ok && r.volume !== want).map((r) => r.device);
    if (toSet.length === 0) break;
  }
  return toSet.length === 0 && active.length > 0;
}

function groupVolumeService(members) {
  for (const device of members || []) {
    const coord = device?.Coordinator || device;
    const svc = coord?.GroupRenderingControlService;
    if (svc?.SnapshotGroupVolume && svc?.SetGroupVolume) return svc;
  }
  return null;
}

async function snapshotGroupVolume(svc) {
  await withTimeout(
    svc.SnapshotGroupVolume({ InstanceID: 0 }),
    playerVolumeTimeoutMs,
    "Sonos group volume snapshot timed out"
  );
}

/**
 * Joining standalone speakers keeps the coordinator's old group volume.
 * Sonos later reapplies that level from the group snapshot, which pulls
 * every player back up. Stamp the equal target as the new group volume
 * so the house stays where Group All put it.
 */
async function stampGroupVolume(members, target) {
  const svc = groupVolumeService(members);
  if (!svc) return;
  const want = Math.max(0, Math.min(100, Math.round(Number(target) || 0)));
  await snapshotGroupVolume(svc);
  await withTimeout(
    svc.SetGroupVolume({ InstanceID: 0, DesiredVolume: want }),
    playerVolumeTimeoutMs,
    "Sonos group volume set timed out"
  );
}

/**
 * Lock every member to `target`, then remember that level for the volume
 * header. The header poll reads this cache and never asks the speakers, so
 * a Group All that skips the cache paints 15 and the next poll restores
 * the pre-group level.
 */
export async function lockAndRememberGroupVolume(members, target) {
  let locked = await lockGroupVolume(members, target);
  if (!locked) return false;
  try {
    await stampGroupVolume(members, target);
    locked = await lockGroupVolume(members, target);
    if (locked) {
      const svc = groupVolumeService(members);
      if (svc) await snapshotGroupVolume(svc);
    }
  } catch (err) {
    console.error(`[volume] group volume stamp failed: ${err.message}`);
  }
  if (locked) noteGroupVolume(target);
  return locked;
}

async function adjustGroupVolume(delta) {
  const members = await groupMembers();
  const active = volumeTargets(members);
  if (!active.length) {
    throw new Error("No reachable Sonos players for group volume.");
  }

  let reference = cachedGroupVolume;
  if (reference == null) {
    // First change after startup: learn the loudest live level once.
    const reads = await Promise.all(
      active.map((device) => readPlayerVolumeSafe(device))
    );
    const ok = reads.filter((r) => r.ok);
    if (!ok.length) {
      throw new Error("Could not read volume from any Sonos player.");
    }
    reference = Math.max(...ok.map((r) => r.volume));
  }
  const target = Math.max(0, Math.min(100, reference + delta));

  const locked = await lockGroupVolume(members, target);
  noteGroupVolume(target);
  return { volume: target, players: liveMembers(members).length, locked };
}

export async function volumeUp(step = VOLUME_STEP) {
  return withSonosTransportLane(() => {
    assertManualVolumeAvailable();
    return adjustGroupVolume(Math.abs(step));
  });
}

export async function volumeDown(step = VOLUME_STEP) {
  return withSonosTransportLane(() => {
    assertManualVolumeAvailable();
    return adjustGroupVolume(-Math.abs(step));
  });
}

// Absolute group volume helpers (0–100) for DJ Voice boost/restore.
// Reads stay unlocked so DJ watch / UI polls don't serialize behind queue writes.
export async function getGroupVolume() {
  const members = await groupMembers();
  const active = volumeTargets(members);
  if (!active.length) {
    throw new Error("No reachable Sonos players for group volume.");
  }
  const reads = await Promise.all(active.map((device) => readPlayerVolumeSafe(device)));
  const ok = reads.filter((r) => r.ok);
  if (!ok.length) {
    throw new Error("Could not read volume from any Sonos player.");
  }
  const volume = Math.max(0, ...ok.map((r) => r.volume || 0));
  noteGroupVolume(volume);
  return volume;
}

export async function setGroupVolume(level) {
  return withSonosTransportLane(() => setGroupVolumeUnlocked(level));
}

async function setGroupVolumeUnlocked(level) {
  const m = await getManager();
  const { members } = await resolveGroup(m);
  const target = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
  const locked = await lockGroupVolume(members, target);
  noteGroupVolume(target);
  invalidateSonosSnapshots({ preserveAnnounceHold: true });
  return { volume: target, players: members.length, locked };
}

/**
 * One SetVolume per reachable member — no read-back, no settle, no correction
 * passes, and no snapshot invalidation. For intermediate DJ ramp steps, where
 * the next step overwrites the level a few hundred ms later and only the
 * endpoint has to land exactly. Busting snapshots here would also nudge the
 * now-playing monitor once per step, which is load we're trying to remove.
 */
export async function setGroupVolumeFast(level) {
  return withSonosTransportLane(() => setGroupVolumeFastUnlocked(level));
}

async function setGroupVolumeFastUnlocked(level) {
  const m = await getManager();
  const { members } = await resolveGroup(m);
  const active = volumeTargets(members);
  if (!active.length) {
    throw new Error("No reachable Sonos players for group volume.");
  }
  const target = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
  await Promise.all(active.map((device) => setPlayerVolumeSafe(device, target)));
  noteGroupVolume(target);
  return { volume: target, players: active.length };
}
