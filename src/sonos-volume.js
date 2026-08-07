import { withSonosTransportLane } from "./sonos-lock.js";
import { getManager, resolveGroup } from "./sonos-core.js";
import { invalidateSonosSnapshots } from "./sonos-snapshots.js";
import { isDjVolumeHandoffActive } from "./dj-volume-handoff-state.js";

const VOLUME_STEP = 1;

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
  let toSet = members;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    await Promise.all(toSet.map((device) => setPlayerVolume(device, want)));
    await sleep(SETTLE_MS);

    const after = await Promise.all(
      members.map(async (device) => ({
        device,
        volume: Number(await readPlayerVolume(device)),
      }))
    );
    // Sonos CurrentVolume is often a string ("20"); strict !== against a
    // number falsely failed restore and left announce volume sticky/loud.
    toSet = after.filter((r) => r.volume !== want).map((r) => r.device);
    if (toSet.length === 0) break;
  }
  return toSet.length === 0;
}

async function adjustGroupVolume(delta) {
  const m = await getManager();
  const { members } = await resolveGroup(m);

  // Read every player's CURRENT volume live, then sync the whole group to the
  // LOUDEST one before applying the step. Example: [12, 8, 8] with +1 -> all 13.
  const volumes = await Promise.all(
    members.map((device) => readPlayerVolume(device))
  );
  const reference = Math.max(...volumes);
  const target = Math.max(0, Math.min(100, reference + delta));

  const locked = await lockGroupVolume(members, target);
  return { volume: target, players: members.length, locked };
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
  const volumes = await Promise.all(
    members.map((device) => readPlayerVolume(device))
  );
  return Math.max(0, ...volumes.map((v) => Number(v) || 0));
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
