import { withSonosWriteLock } from "./sonos-lock.js";
import {
  getManager,
  resolveCoordinator,
  getZoneGroups,
  deviceForMember,
  clearZoneCache,
} from "./sonos-core.js";
import { invalidateSonosSnapshots, groupLabel } from "./sonos-snapshots.js";
import {
  assertManualVolumeAvailable,
  lockGroupVolume,
  sleep,
  SETTLE_MS,
} from "./sonos-volume.js";
import { pickGroupByTarget } from "./sonos-queue-policy.js";
import { getSonosTargetRoom, setSonosTargetRoom } from "./settings.js";

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

// Party button: pull every speaker into ONE group and set them all to a known
// volume. We anchor on the current target-room coordinator so whatever is
// playing keeps playing; every other room joins that group.
const GROUP_ALL_VOLUME = 15;

export async function groupAll(...args) {
  return withSonosWriteLock(() => {
    assertManualVolumeAvailable();
    return groupAllUnlocked(...args);
  });
}

async function groupAllUnlocked() {
  const m = await getManager();
  const anchor = await resolveCoordinator(m);

  // Join each other room to the anchor's group (sequential to avoid topology
  // races). Already-grouped rooms are effectively a no-op.
  for (const device of m.Devices) {
    if (device.Uuid === anchor.Uuid) continue;
    try {
      await device.JoinGroup(anchor.Name);
    } catch (err) {
      console.error(`[group-all] ${device.Name} join failed:`, err.message);
    }
  }

  // Let the topology change settle, then drop the cache so later resolves see
  // the new single group, and lock every player to the party volume.
  await sleep(SETTLE_MS);
  clearZoneCache();

  const locked = await lockGroupVolume(m.Devices, GROUP_ALL_VOLUME);
  invalidateSonosSnapshots();
  return { players: m.Devices.length, volume: GROUP_ALL_VOLUME, locked };
}

function findDeviceByName(m, room) {
  const name = String(room || "").trim().toLowerCase();
  if (!name) return null;
  return m.Devices.find((d) => d.Name.toLowerCase() === name) || null;
}

// Join one speaker to the currently targeted group's coordinator.
export async function joinSpeakerToTarget(room) {
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

  await device.JoinGroup(anchor.Name);
  await sleep(SETTLE_MS);
  clearZoneCache();
  invalidateSonosSnapshots();
  return { room: device.Name, coordinator: anchor.Name, joined: true };
}

// Leave the current group (become a standalone coordinator).
export async function leaveSpeakerGroup(room) {
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
  return { room: device.Name, left: true };
}

// Split every multi-room group so each speaker stands alone.
export async function ungroupAll() {
  const m = await getManager();
  let changed = 0;

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
      await device.AVTransportService.BecomeCoordinatorOfStandaloneGroup({
        InstanceID: 0,
      });
      changed += 1;
      await sleep(150);
    } catch (err) {
      console.error(`[ungroup-all] ${device.Name} leave failed:`, err.message);
    }
  }

  await sleep(SETTLE_MS);
  clearZoneCache();
  invalidateSonosSnapshots();
  return { players: m.Devices.length, ungrouped: changed };
}

// Allow the album-art proxy to fetch only from known Sonos speakers (port 1400).
export async function isKnownSonosHost(host) {
  const m = await getManager();
  return m.Devices.some((d) => d.Host === host);
}
