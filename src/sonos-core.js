import { SonosManager } from "@svrooij/sonos";
import {
  configureSonosManagerHealth,
  noteSonosReadSuccess,
  noteSonosReadFailure,
  clearSonosUnhealthy,
} from "./sonos-manager-health.js";
import { pickGroupByTarget } from "./sonos-queue-policy.js";
import { getSonosTargetRoom } from "./settings.js";
import { envTimeoutMs, withTimeout } from "./with-timeout.js";

/** Connect / discovery budget (discovery itself asks for ~10s). */
const SONOS_CONNECT_TIMEOUT_MS = envTimeoutMs(
  "PARTYQUEUE_SONOS_CONNECT_TIMEOUT_MS",
  15_000
);

// Sonos Spotify "region" codes used when building track metadata.
// These map to the SA_RINCON<region> service id the library embeds.
const SPOTIFY_REGION_EU = "2311";
const SPOTIFY_REGION_US = "3079";

let manager = null;
let initializing = null;

function dropSonosManager() {
  manager = null;
  initializing = null;
}

/** Drop the cached SonosManager so the next call rediscovers (e.g. after SONOS_HOST change). */
export function resetSonosManager() {
  dropSonosManager();
  // Host/config-driven reset: start a fresh unhealthy clock so auto-reset
  // doesn't immediately fire again on the next blip.
  clearSonosUnhealthy();
}

let snapshotInvalidator = null;

/** Wired by sonos-snapshots.js so health reset can bust caches without a cycle. */
export function setSonosSnapshotInvalidator(fn) {
  snapshotInvalidator = typeof fn === "function" ? fn : null;
}

configureSonosManagerHealth({
  reset: () => {
    dropSonosManager();
    // Bust coalesced snapshots so the next poll cannot reuse pre-reset data.
    try {
      snapshotInvalidator?.();
    } catch {
      /* invalidator may not be registered yet */
    }
  },
});

export function resolveRegion() {
  const region = (process.env.SONOS_REGION || "NorthAmerica").toLowerCase();
  return region === "eu" || region === "europe"
    ? SPOTIFY_REGION_EU
    : SPOTIFY_REGION_US;
}

export async function getManager() {
  if (manager) return manager;
  // Guard against concurrent requests triggering multiple discoveries.
  if (initializing) return initializing;

  initializing = (async () => {
    const m = new SonosManager();
    // Prefer Settings → Connections (data/sonos.json / .env via sonos-config).
    const { getSonosHost } = await import("./sonos-config.js");
    const host = String(getSonosHost() || "").trim();

    if (host) {
      await withTimeout(
        m.InitializeFromDevice(host),
        SONOS_CONNECT_TIMEOUT_MS,
        `Sonos connect timed out after ${Math.ceil(SONOS_CONNECT_TIMEOUT_MS / 1000)}s`
      );
    } else {
      const found = await withTimeout(
        m.InitializeWithDiscovery(10),
        SONOS_CONNECT_TIMEOUT_MS,
        `Sonos discovery timed out after ${Math.ceil(SONOS_CONNECT_TIMEOUT_MS / 1000)}s`
      );
      if (!found || m.Devices.length === 0) {
        throw new Error(
          "No Sonos devices found on the network. Set a speaker IP under DJ Booth → Settings → Connections (or SONOS_HOST), especially across VLANs/VPNs."
        );
      }
    }

    manager = m;
    noteSonosReadSuccess();
    return manager;
  })();

  try {
    return await initializing;
  } catch (err) {
    noteSonosReadFailure();
    throw err;
  } finally {
    initializing = null;
  }
}

let zoneCache = { at: 0, groups: null };
let zoneInFlight = null;
let zoneGeneration = 0;
const ZONE_TTL_MS = 2000;

export async function getZoneGroups(m, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && zoneCache.groups && now - zoneCache.at < ZONE_TTL_MS) {
    return zoneCache.groups;
  }
  // Collapse concurrent topology reads (many phones + DJ watch + autofill).
  // Do not join an in-flight read when the caller asked for fresh — join/leave
  // may have just cleared the cache, and a pre-mutation request must not win.
  if (zoneInFlight && !fresh) return zoneInFlight;
  const readGeneration = zoneGeneration;
  const request = (async () => {
    try {
      const groups = await m.Devices[0].GetZoneGroupState();
      // clearZoneCache() bumps generation; never let a superseded read refill.
      if (readGeneration === zoneGeneration) {
        zoneCache = { at: Date.now(), groups };
      }
      return groups;
    } finally {
      if (zoneInFlight === request) zoneInFlight = null;
    }
  })();
  zoneInFlight = request;
  return request;
}

// Map a topology member (uuid/host) back to a managed SonosDevice instance.
export function deviceForMember(m, member) {
  if (!member) return null;
  return (
    m.Devices.find((d) => d.Uuid === member.uuid) ||
    m.Devices.find((d) => d.Host === member.host) ||
    null
  );
}

// Cached-topology fallback, used only if a live topology query fails.
function resolveCoordinatorCached(m, targetRoom) {
  if (targetRoom) {
    const device = m.Devices.find(
      (d) => d.Name.toLowerCase() === targetRoom.toLowerCase()
    );
    if (!device) {
      const available = m.Devices.map((d) => d.Name).join(", ");
      throw new Error(
        `Sonos room "${targetRoom}" not found. Available rooms: ${available || "(none)"}`
      );
    }
    return device.Coordinator ?? device;
  }
  const first = m.Devices[0];
  return first.Coordinator ?? first;
}

// Resolve the target group from live topology: its real coordinator plus all
// member devices. Uses the persisted/UI target room, then SONOS_ROOM from env;
// otherwise the first group.
export async function resolveGroup(m, opts = {}) {
  const targetRoom = getSonosTargetRoom();

  let groups = null;
  try {
    groups = await getZoneGroups(m, opts);
  } catch {
    groups = null;
  }

  if (groups && groups.length) {
    let group;
    if (targetRoom) {
      group = pickGroupByTarget(groups, targetRoom);
      if (!group) {
        const available = groups
          .flatMap((g) => g.members?.map((mem) => mem.name) ?? [])
          .join(", ");
        throw new Error(
          `Sonos room "${targetRoom}" not found. Available rooms: ${available || "(none)"}`
        );
      }
    } else {
      group = groups[0];
    }

    const coordinator = deviceForMember(m, group.coordinator);
    const members = (group.members ?? [])
      .map((mem) => deviceForMember(m, mem))
      .filter(Boolean);

    if (coordinator) {
      return { coordinator, members: members.length ? members : [coordinator] };
    }
  }

  // Live query failed (or device not found): fall back to cached topology.
  const coordinator = resolveCoordinatorCached(m, targetRoom);
  const members = m.Devices.filter(
    (d) => d.GroupName && d.GroupName === coordinator.GroupName
  );
  return { coordinator, members: members.length ? members : [coordinator] };
}

// Find the coordinator that owns the queue we should add to / control.
export async function resolveCoordinator(m, opts = {}) {
  return (await resolveGroup(m, opts)).coordinator;
}

// True when a Sonos error means "you sent a coordinator-only command to a
// speaker that isn't the coordinator" (happens when our topology was stale).
export function isNotCoordinatorError(err) {
  return /\b800\b/.test(err?.message ?? "");
}

export function clearZoneCache() {
  zoneGeneration += 1;
  zoneCache = { at: 0, groups: null };
  // Drop coalescing so the next reader starts a post-mutation SOAP query
  // instead of awaiting a topology snapshot taken before join/leave/ungroup.
  zoneInFlight = null;
}

/** Test helper — zone cache bookkeeping after clearZoneCache. */
export function zoneCacheInfoForTests() {
  return {
    generation: zoneGeneration,
    hasCache: !!zoneCache.groups,
    hasInFlight: !!zoneInFlight,
  };
}
