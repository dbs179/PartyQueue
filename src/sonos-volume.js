import { withSonosTransportLane } from "./sonos-lock.js";
import { getManager, resolveGroup } from "./sonos-core.js";
import { invalidateSonosSnapshots } from "./sonos-snapshots.js";
import { isDjVolumeHandoffActive } from "./dj-volume-handoff-state.js";
import { envTimeoutMs, withTimeout } from "./with-timeout.js";
import { isSonosUnreachableError } from "./sonos-reachability.js";

const VOLUME_STEP = 1;
const PLAYER_VOLUME_TIMEOUT_MS = envTimeoutMs(
  "PARTYQUEUE_PLAYER_VOLUME_TIMEOUT_MS",
  2_000
);
const SKIP_UNREACHABLE_MS = 60_000;

let playerVolumeTimeoutMs = PLAYER_VOLUME_TIMEOUT_MS;
let skipUnreachableMs = SKIP_UNREACHABLE_MS;
/** @type {Map<string, number>} host -> skip-until epoch ms */
const unreachableUntil = new Map();

export function setPlayerVolumeTimeoutForTests(ms) {
  if (ms != null) playerVolumeTimeoutMs = Number(ms);
}
export function setSkipUnreachableMsForTests(ms) {
  if (ms != null) skipUnreachableMs = Number(ms);
}
export function resetVolumeReachabilityForTests() {
  playerVolumeTimeoutMs = PLAYER_VOLUME_TIMEOUT_MS;
  skipUnreachableMs = SKIP_UNREACHABLE_MS;
  unreachableUntil.clear();
}

function playerKey(device) {
  return String(device?.Host || device?.Uuid || device?.Name || "");
}

function isPlayerSkipped(device, now = Date.now()) {
  const key = playerKey(device);
  if (!key) return false;
  const until = unreachableUntil.get(key);
  if (!until) return false;
  if (now >= until) {
    unreachableUntil.delete(key);
    return false;
  }
  return true;
}

function markPlayerUnreachable(device, now = Date.now()) {
  const key = playerKey(device);
  if (!key) return;
  const already = unreachableUntil.has(key);
  unreachableUntil.set(key, now + skipUnreachableMs);
  if (!already) {
    console.warn(
      `[sonos] skipping unreachable player ${key} for ${Math.round(skipUnreachableMs / 1000)}s`
    );
  }
}

function markPlayerReachable(device) {
  const key = playerKey(device);
  if (key) unreachableUntil.delete(key);
}

function liveMembers(members, now = Date.now()) {
  return (members || []).filter((device) => !isPlayerSkipped(device, now));
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
    if (isSonosUnreachableError(err) || /timed out/i.test(String(err?.message || ""))) {
      markPlayerUnreachable(device);
    }
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
    if (isSonosUnreachableError(err) || /timed out/i.test(String(err?.message || ""))) {
      markPlayerUnreachable(device);
    }
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
export async function lockGroupVolume(members, target) {
  const want = Math.max(0, Math.min(100, Math.round(Number(target) || 0)));
  let active = liveMembers(members);
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

async function adjustGroupVolume(delta) {
  const m = await getManager();
  const { members } = await resolveGroup(m);
  const active = liveMembers(members);
  if (!active.length) {
    throw new Error("No reachable Sonos players for group volume.");
  }

  // Read every reachable player's CURRENT volume live, then sync the whole
  // group to the LOUDEST one before applying the step.
  const reads = await Promise.all(active.map((device) => readPlayerVolumeSafe(device)));
  const ok = reads.filter((r) => r.ok);
  if (!ok.length) {
    throw new Error("Could not read volume from any Sonos player.");
  }
  const reference = Math.max(...ok.map((r) => r.volume));
  const target = Math.max(0, Math.min(100, reference + delta));

  const locked = await lockGroupVolume(members, target);
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
  const m = await getManager();
  const { members } = await resolveGroup(m);
  const active = liveMembers(members);
  if (!active.length) {
    throw new Error("No reachable Sonos players for group volume.");
  }
  const reads = await Promise.all(active.map((device) => readPlayerVolumeSafe(device)));
  const ok = reads.filter((r) => r.ok);
  if (!ok.length) {
    throw new Error("Could not read volume from any Sonos player.");
  }
  return Math.max(0, ...ok.map((r) => r.volume || 0));
}

export async function setGroupVolume(level) {
  return withSonosTransportLane(() => setGroupVolumeUnlocked(level));
}

async function setGroupVolumeUnlocked(level) {
  const m = await getManager();
  const { members } = await resolveGroup(m);
  const target = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
  const locked = await lockGroupVolume(members, target);
  invalidateSonosSnapshots();
  return { volume: target, players: members.length, locked };
}
