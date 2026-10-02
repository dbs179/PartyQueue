import { withSonosTransportLane, withSonosWriteLock } from "./sonos-lock.js";
import {
  getManager,
  resolveCoordinator,
  resolveGroup,
  getZoneGroups,
  deviceForMember,
  clearZoneCache,
} from "./sonos-core.js";
import {
  invalidateSonosSnapshots,
  groupLabel,
  parseSonosTime,
} from "./sonos-snapshots.js";
import {
  assertManualVolumeAvailable,
  lockGroupVolume,
  sleep,
  SETTLE_MS,
} from "./sonos-volume.js";
import { pickGroupByTarget } from "./sonos-queue-policy.js";
import { getSonosTargetRoom, setSonosTargetRoom } from "./settings.js";
import { isDjVolumeHandoffActive } from "./dj-volume-handoff.js";
import {
  ensureOrderedPlayModeOn,
  getAnnouncePlaybackContext,
  resumeQueuePlayback,
} from "./sonos-transport.js";
import {
  shouldResumeAfterTopology,
  wasPlayingFromQueue,
} from "./sonos-topology-resume.js";
import {
  isPlayerSkipped,
  markPlayerReachable,
  noteSpeakerFailure,
} from "./sonos-reachability.js";
import { envTimeoutMs, withTimeout } from "./with-timeout.js";
import { formatSonosRelTime } from "./skip-announce-policy.js";
import {
  GROUP_ALL_ROOM,
  coordinateGroupAll,
  shouldCopyQueue,
} from "./sonos-group-all.js";

/** Per-speaker budget for a topology write, so one dead box can't pin the lane. */
const JOIN_TIMEOUT_MS = envTimeoutMs("PARTYQUEUE_SONOS_JOIN_TIMEOUT_MS", 5_000);

async function captureTargetWasPlaying() {
  try {
    return wasPlayingFromQueue(await getAnnouncePlaybackContext());
  } catch {
    return false;
  }
}

async function maybeResumeTargetAfterTopology(wasPlaying) {
  try {
    const after = await getAnnouncePlaybackContext();
    if (
      !shouldResumeAfterTopology({
        wasPlaying,
        handoffActive: isDjVolumeHandoffActive(),
        after,
      })
    ) {
      return;
    }
    await resumeQueuePlayback();
    console.log("[sonos-groups] resumed target after topology change");
  } catch (err) {
    console.warn(
      "[sonos-groups] resume after topology change failed:",
      err.message
    );
  }
}

export async function listRooms() {
  const m = await getManager();
  return m.Devices.map((d) => ({
    name: d.Name,
    group: d.GroupName,
    isCoordinator: d.Coordinator?.Uuid === d.Uuid,
  }));
}

// Switch which Sonos group PartyQueue controls. `room` is a coordinator or
// member name from the live topology.
export async function selectGroup(room) {
  const name = String(room || "").trim();
  if (!name) throw new Error("Missing room name.");

  const m = await getManager();
  clearZoneCache();
  const groups = await getZoneGroups(m, { fresh: true });
  const group = pickGroupByTarget(groups, name);
  if (!group) {
    const available = groups
      .flatMap((g) => g.members?.map((mem) => mem.name) ?? [])
      .join(", ");
    throw new Error(`Sonos room "${name}" not found. Available: ${available || "(none)"}`);
  }

  const coordinator = group.coordinator?.name ?? name;
  setSonosTargetRoom(coordinator);
  invalidateSonosSnapshots();

  const members = (group.members ?? []).map((mem) => mem.name).filter(Boolean);
  return {
    targetRoom: coordinator,
    label: groupLabel(group),
    coordinator,
    members,
    memberCount: members.length,
  };
}

// Party button: one group, Living Room in charge, volume locked, queue kept.
// Sonos will not move the coordinator by joining onto a member, so when
// Living Room is only a member we delegate. If that handoff fails we copy
// the party queue onto Living Room and start it again at the same spot.
const GROUP_ALL_VOLUME = 15;

export async function groupAll() {
  // Fail before taking the queue lock if a DJ ramp owns the volume knob.
  assertManualVolumeAvailable();
  let releaseHold = null;
  let joined = null;
  try {
    joined = await withSonosWriteLock(() =>
      groupAllUnlocked((release) => {
        releaseHold = release;
      })
    );
    // Playback and volume use the transport lane, and only after joins
    // release the write lock. Holding both at once can deadlock a DJ ramp
    // that needs the queue.
    if (joined.playback?.copied) {
      try {
        await withSonosTransportLane(() => restartCopiedQueue(joined.playback));
      } catch (err) {
        console.error(`[group-all] restart failed: ${err.message}`);
      }
    } else if (joined.wasPlaying) {
      await maybeResumeTargetAfterTopology(true);
    }
    let locked = false;
    try {
      locked = await withSonosTransportLane(() =>
        lockGroupVolume(joined.volumeMembers, GROUP_ALL_VOLUME)
      );
    } catch (err) {
      console.error(`[group-all] volume lock failed: ${err.message}`);
    }
    invalidateSonosSnapshots();
    return { players: joined.players, volume: GROUP_ALL_VOLUME, locked };
  } finally {
    if (typeof releaseHold === "function") releaseHold();
  }
}

function plainDevice(device) {
  const coord = device.Coordinator ?? device;
  return {
    name: device.Name,
    uuid: device.Uuid,
    coordinatorUuid: coord?.Uuid,
    skipped: isPlayerSkipped(device),
  };
}

async function joinDevice(device, targetName) {
  await withTimeout(
    device.JoinGroup(targetName),
    JOIN_TIMEOUT_MS,
    `Sonos join timed out after ${Math.ceil(JOIN_TIMEOUT_MS / 1000)}s`
  );
  markPlayerReachable(device);
}

async function snapshotCoordinatorQueue(device) {
  const [queue, pos, media, transport] = await Promise.all([
    device.GetQueue(),
    device.AVTransportService.GetPositionInfo().catch(() => ({})),
    device.AVTransportService.GetMediaInfo({ InstanceID: 0 }).catch(() => ({})),
    device.AVTransportService.GetTransportInfo().catch(() => ({})),
  ]);
  const items = Array.isArray(queue?.Result) ? queue.Result : [];
  const playingFromQueue = /^x-rincon-queue:/.test(String(media?.CurrentURI || ""));
  const state = String(transport?.CurrentTransportState || "");
  return {
    playingFromQueue,
    isPlaying: state === "PLAYING" || state === "TRANSITIONING",
    track: Number(pos?.Track) || 0,
    positionSec: parseSonosTime(pos?.RelTime) || 0,
    uris: playingFromQueue
      ? items.map((item) => String(item?.TrackUri || item?.uri || "")).filter(Boolean)
      : [],
  };
}

async function stopAndClearDevice(device) {
  try {
    await device.Stop();
  } catch {
    /* best effort */
  }
  try {
    await device.AVTransportService.RemoveAllTracksFromQueue({ InstanceID: 0 });
  } catch (err) {
    if (!/\b804\b/.test(err?.message ?? "")) throw err;
  }
}

async function enqueueCopiedUri(device, uri) {
  await withTimeout(
    device.AVTransportService.AddURIToQueue({
      InstanceID: 0,
      EnqueuedURI: uri,
      EnqueuedURIMetaData: "",
      DesiredFirstTrackNumberEnqueued: 0,
      EnqueueAsNext: false,
    }),
    JOIN_TIMEOUT_MS,
    `Sonos enqueue timed out after ${Math.ceil(JOIN_TIMEOUT_MS / 1000)}s`
  );
}

// Snapshot first. A failed read leaves the current groups alone. After a
// good read, split the house, wipe private queues, and put the party list
// on Living Room.
async function rebuildPartyQueueOnLivingRoom(m, anchorDevice, onHold) {
  const snap = await snapshotCoordinatorQueue(anchorDevice);
  const { holdNeverEnding } = await import("./autofill.js");
  const { preemptQueueWork } = await import("./queue-preempt.js");
  preemptQueueWork();
  onHold(holdNeverEnding());
  await ungroupAllUnlocked({ resume: false });

  const fresh = await getManager();
  const living = findDeviceByName(fresh, GROUP_ALL_ROOM);
  if (!living) {
    throw new Error("Living Room disappeared while grouping speakers.");
  }
  for (const device of fresh.Devices) {
    try {
      await stopAndClearDevice(device);
    } catch (err) {
      if (device.Uuid === living.Uuid) throw err;
      noteSpeakerFailure(device, err);
      console.error(`[group-all] ${device.Name} queue clear failed:`, err.message);
    }
  }
  if (!shouldCopyQueue(snap)) return { copied: false };

  await ensureOrderedPlayModeOn(living);
  for (const uri of snap.uris) {
    await enqueueCopiedUri(living, uri);
  }
  return {
    copied: true,
    track: snap.track >= 1 ? snap.track : 1,
    positionSec: snap.positionSec,
    play: snap.isPlaying,
  };
}

async function restartCopiedQueue(playback) {
  const m = await getManager();
  const coordinator = await resolveCoordinator(m);
  let onQueue = false;
  try {
    const media = await coordinator.AVTransportService.GetMediaInfo({
      InstanceID: 0,
    });
    onQueue = /^x-rincon-queue:/.test(String(media?.CurrentURI || ""));
  } catch {
    /* fall through to SwitchToQueue */
  }
  if (!onQueue) await coordinator.SwitchToQueue();
  const track = Number(playback.track) || 0;
  if (track >= 1) {
    await coordinator.AVTransportService.Seek({
      InstanceID: 0,
      Unit: "TRACK_NR",
      Target: String(track),
    });
  }
  const positionSec = Number(playback.positionSec) || 0;
  if (positionSec > 1) {
    await coordinator.AVTransportService.Seek({
      InstanceID: 0,
      Unit: "REL_TIME",
      Target: formatSonosRelTime(positionSec),
    });
  }
  if (playback.play) await coordinator.Play();
  invalidateSonosSnapshots();
}

async function joinOutsidersToLivingRoom(m) {
  await sleep(SETTLE_MS);
  clearZoneCache();
  let memberUuids = null;
  try {
    const groups = await getZoneGroups(m, { fresh: true });
    const group = (groups || []).find(
      (entry) => entry.coordinator?.name?.toLowerCase() === GROUP_ALL_ROOM.toLowerCase()
    );
    if (group) {
      memberUuids = new Set((group.members ?? []).map((member) => member.uuid));
    }
  } catch (err) {
    console.warn(`[group-all] topology read before join failed: ${err.message}`);
  }

  const living = findDeviceByName(m, GROUP_ALL_ROOM);
  for (const device of m.Devices) {
    if (living && device.Uuid === living.Uuid) continue;
    if (memberUuids && memberUuids.has(device.Uuid)) continue;
    try {
      await joinDevice(device, GROUP_ALL_ROOM);
    } catch (err) {
      noteSpeakerFailure(device, err);
      console.error(`[group-all] ${device.Name} join failed:`, err.message);
    }
  }
}

async function groupAllUnlocked(onHold) {
  const m = await getManager();
  const anchor = await resolveCoordinator(m);
  const wasPlaying = await captureTargetWasPlaying();

  const coordinated = await coordinateGroupAll({
    devices: m.Devices.map(plainDevice),
    anchor: { name: anchor.Name, uuid: anchor.Uuid },
    ops: {
      join: async (plain, target) => {
        const device = m.Devices.find((entry) => entry.Uuid === plain.uuid);
        if (!device) {
          throw new Error(`Sonos room "${plain.name}" not found.`);
        }
        await joinDevice(device, target.name);
      },
      delegate: async (_anchorPlain, living) => {
        await withTimeout(
          anchor.AVTransportService.DelegateGroupCoordinationTo({
            InstanceID: 0,
            NewCoordinator: living.uuid,
            RejoinGroup: true,
          }),
          JOIN_TIMEOUT_MS,
          `Sonos coordinator handoff timed out after ${Math.ceil(JOIN_TIMEOUT_MS / 1000)}s`
        );
        markPlayerReachable(anchor);
      },
      rebuild: () => rebuildPartyQueueOnLivingRoom(m, anchor, onHold),
      setTarget: (name) => {
        setSonosTargetRoom(name);
      },
      joinOutsiders: () => joinOutsidersToLivingRoom(m),
    },
  });

  await sleep(SETTLE_MS);
  clearZoneCache();

  let volumeMembers = [anchor];
  try {
    const group = await resolveGroup(m, { fresh: true });
    if (group?.members?.length) volumeMembers = group.members;
  } catch (err) {
    console.warn(
      `[group-all] party group lookup after join failed: ${err.message}`
    );
  }
  return {
    players: m.Devices.length,
    volumeMembers,
    wasPlaying,
    mode: coordinated.mode,
    playback: coordinated.playback,
  };
}

function findDeviceByName(m, room) {
  const name = String(room || "").trim().toLowerCase();
  if (!name) return null;
  return m.Devices.find((d) => d.Name.toLowerCase() === name) || null;
}

// Join one speaker to the currently targeted group's coordinator.
// Serialized with guest adds: a JoinGroup that lands mid-insert moves the
// coordinator out from under AddURIToQueue.
export async function joinSpeakerToTarget(room) {
  return withSonosWriteLock(() => joinSpeakerToTargetUnlocked(room));
}

async function joinSpeakerToTargetUnlocked(room) {
  const name = String(room || "").trim();
  if (!name) throw new Error("Missing room name.");

  const m = await getManager();
  const device = findDeviceByName(m, name);
  if (!device) {
    const available = m.Devices.map((d) => d.Name).join(", ");
    throw new Error(`Sonos room "${name}" not found. Available: ${available || "(none)"}`);
  }

  const anchor = await resolveCoordinator(m);
  if (device.Uuid === anchor.Uuid) {
    return { room: device.Name, coordinator: anchor.Name, alreadyInGroup: true };
  }

  try {
    await withTimeout(
      device.JoinGroup(anchor.Name),
      JOIN_TIMEOUT_MS,
      `Sonos join timed out after ${Math.ceil(JOIN_TIMEOUT_MS / 1000)}s`
    );
    markPlayerReachable(device);
  } catch (err) {
    noteSpeakerFailure(device, err);
    throw err;
  }
  await sleep(SETTLE_MS);
  clearZoneCache();
  invalidateSonosSnapshots();
  return { room: device.Name, coordinator: anchor.Name, joined: true };
}

// Leave the current group (become a standalone coordinator).
export async function leaveSpeakerGroup(room) {
  return withSonosWriteLock(() => leaveSpeakerGroupUnlocked(room));
}

async function leaveSpeakerGroupUnlocked(room) {
  const name = String(room || "").trim();
  if (!name) throw new Error("Missing room name.");

  const m = await getManager();
  const device = findDeviceByName(m, name);
  if (!device) {
    const available = m.Devices.map((d) => d.Name).join(", ");
    throw new Error(`Sonos room "${name}" not found. Available: ${available || "(none)"}`);
  }

  // Already alone — nothing to do.
  const coord = device.Coordinator ?? device;
  const alone =
    m.Devices.filter((d) => (d.Coordinator ?? d).Uuid === coord.Uuid).length <= 1;
  if (alone) {
    return { room: device.Name, alreadyStandalone: true };
  }

  const wasPlaying = await captureTargetWasPlaying();

  await device.AVTransportService.BecomeCoordinatorOfStandaloneGroup({
    InstanceID: 0,
  });
  await sleep(SETTLE_MS);
  clearZoneCache();

  // If we just ungrouped the saved target, retarget this speaker (now standalone).
  const target = getSonosTargetRoom();
  if (target && target.toLowerCase() === device.Name.toLowerCase()) {
    setSonosTargetRoom(device.Name);
  }

  invalidateSonosSnapshots();
  await maybeResumeTargetAfterTopology(wasPlaying);
  return { room: device.Name, left: true };
}

// Split every multi-room group so each speaker stands alone.
export async function ungroupAll() {
  return withSonosWriteLock(() => ungroupAllUnlocked());
}

async function ungroupAllUnlocked({ resume = true } = {}) {
  const m = await getManager();
  let changed = 0;
  const wasPlaying = resume ? await captureTargetWasPlaying() : false;

  // Snapshot membership first; BecomeCoordinator changes topology as we go.
  const groups = await getZoneGroups(m, { fresh: true });
  const multiMembers = [];
  for (const g of groups) {
    const members = g.members ?? [];
    if (members.length <= 1) continue;
    for (const mem of members) {
      const device = deviceForMember(m, mem);
      if (device) multiMembers.push(device);
    }
  }

  for (const device of multiMembers) {
    try {
      await withTimeout(
        device.AVTransportService.BecomeCoordinatorOfStandaloneGroup({
          InstanceID: 0,
        }),
        JOIN_TIMEOUT_MS,
        `Sonos ungroup timed out after ${Math.ceil(JOIN_TIMEOUT_MS / 1000)}s`
      );
      markPlayerReachable(device);
      changed += 1;
      await sleep(150);
    } catch (err) {
      noteSpeakerFailure(device, err);
      console.error(`[ungroup-all] ${device.Name} leave failed:`, err.message);
    }
  }

  await sleep(SETTLE_MS);
  clearZoneCache();
  invalidateSonosSnapshots();
  if (resume && changed > 0) await maybeResumeTargetAfterTopology(wasPlaying);
  return { players: m.Devices.length, ungrouped: changed };
}

// Allow the album-art proxy to fetch only from known Sonos speakers (port 1400).
export async function isKnownSonosHost(host) {
  const m = await getManager();
  return m.Devices.some((d) => d.Host === host);
}
