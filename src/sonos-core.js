import { SonosManager } from "@svrooij/sonos";
import {
  configureSonosManagerHealth,
  noteSonosReadSuccess,
  noteSonosReadFailure,
  clearSonosUnhealthy,
} from "./sonos-manager-health.js";
import { pickGroupByTarget } from "./sonos-queue-policy.js";
import { getSonosTargetRoom } from "./settings.js";
import { getSonosHost } from "./sonos-config.js";
import {
  isPlayerSkipped,
  markPlayerReachable,
  noteSpeakerFailure,
} from "./sonos-reachability.js";
import { envTimeoutMs, withTimeout } from "./with-timeout.js";

// PartyQueue reads topology with its own GetZoneGroupState polls and never
// consumes UPnP zone events. Leaving the library's subscription on means the
// speaker holds a callback for us, re-SUBSCRIBEs every 600s, and NOTIFYs us on
// every topology change — pure load on one box for data we ignore. Opt out
// unless the operator explicitly asked for events.
if (process.env.SONOS_DISABLE_EVENTS === undefined) {
  process.env.SONOS_DISABLE_EVENTS = "true";
}

/** Connect / discovery budget (discovery itself asks for ~10s). */
const SONOS_CONNECT_TIMEOUT_MS = envTimeoutMs(
  "PARTYQUEUE_SONOS_CONNECT_TIMEOUT_MS",
  15_000
);
/** Per-device topology budget so a wedged SONOS_HOST can fail over. */
const ZONE_DEVICE_TIMEOUT_MS = envTimeoutMs(
  "PARTYQUEUE_ZONE_DEVICE_TIMEOUT_MS",
  4_000
);
const ZONE_DEVICE_FAILOVER_LIMIT = 3;

/**
 * Household topology XML is the same on every speaker. Probe the configured
 * party host / target room first — SSDP order often puts a satellite (Office)
 * at Devices[0], and GetZoneGroupState on that box can knock it offline.
 *
 * Speakers inside their unreachable cool-off sink to the back rather than being
 * dropped: if every speaker is skipped we still need something to ask.
 */
export function orderTopologyProbeDevices(
  devices,
  { preferHost = "", preferRoom = "", now = Date.now() } = {}
) {
  const list = Array.isArray(devices) ? [...devices] : [];
  const host = String(preferHost || "").trim().toLowerCase();
  const room = String(preferRoom || "").trim().toLowerCase();
  const score = (device) => {
    const dHost = String(device?.Host || "").trim().toLowerCase();
    const dName = String(device?.Name || "").trim().toLowerCase();
    // A known-dead box is the last thing we should ask for topology, even when
    // it is the target — the failover chain will find a live speaker instead.
    const penalty = isPlayerSkipped(device, now) ? 10 : 0;
    // Target coordinator first: it already handles queue/transport SOAP.
    // Pinned SONOS_HOST (Kitchen Amp) is failover, not an extra hammer.
    if (room && dName === room) return penalty;
    if (host && dHost === host) return 1 + penalty;
    return 2 + penalty;
  };
  // Score once: isPlayerSkipped prunes expired entries as it reads, so the
  // comparator must not be the thing calling it.
  const scored = list.map((device, index) => ({
    device,
    index,
    score: score(device),
  }));
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.map((entry) => entry.device);
}

// Sonos Spotify "region" codes used when building track metadata.
// These map to the SA_RINCON<region> service id the library embeds.
const SPOTIFY_REGION_EU = "2311";
const SPOTIFY_REGION_US = "3079";

let manager = null;
let initializing = null;

function dropSonosManager() {
  // CancelSubscription is what clears the library's 600s renewal interval. Skip
  // it and the orphaned zone service lives forever, re-subscribing to a speaker
  // on behalf of a manager nobody holds — one more immortal subscription per
  // reset, all of them NOTIFY'd on every topology change.
  try {
    manager?.CancelSubscription();
  } catch (err) {
    console.warn(
      "[sonos] cancelling zone event subscription failed:",
      err?.message || err
    );
  }
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

/** Shutdown hook: release any speaker-side event subscription before exit. */
export function closeSonosManager() {
  dropSonosManager();
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

/** Cool-off between device-list rebuilds triggered by topology drift. */
export const DEVICE_DRIFT_REFRESH_MS = 60_000;
let lastDeviceDriftRefreshAt = 0;
let deviceDriftRefreshes = 0;

/**
 * With zone events off, nothing pushes a returning or brand-new speaker into
 * m.Devices. Live topology is the signal instead: a member we cannot map to a
 * managed device means the list is stale, so drop the manager once and let the
 * next getManager() rebuild it. Debounced, because a member that stays
 * unmappable must not rediscover on every poll.
 * @returns {boolean} whether a refresh was triggered
 */
function noteTopologyDeviceDrift(m, groups, now = Date.now()) {
  let devices;
  try {
    // SonosManager.Devices throws while the device list is still empty.
    devices = m?.Devices;
  } catch {
    return false;
  }
  if (!Array.isArray(devices) || !devices.length) return false;

  const known = new Set();
  for (const device of devices) {
    if (device?.Uuid) known.add(String(device.Uuid));
    if (device?.Host) known.add(String(device.Host));
  }

  const missing = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const member of group?.members ?? []) {
      const uuid = member?.uuid ? String(member.uuid) : "";
      const host = member?.host ? String(member.host) : "";
      if ((uuid && known.has(uuid)) || (host && known.has(host))) continue;
      missing.push(member?.name || uuid || host || "unknown");
    }
  }
  if (!missing.length) return false;

  if (
    lastDeviceDriftRefreshAt &&
    now - lastDeviceDriftRefreshAt < DEVICE_DRIFT_REFRESH_MS
  ) {
    return false;
  }
  lastDeviceDriftRefreshAt = now;
  deviceDriftRefreshes += 1;
  console.warn(
    `[sonos] topology lists unmanaged speaker(s) (${missing.join(", ")}); rebuilding device list`
  );
  dropSonosManager();
  return true;
}

/** Test helper — clear the device-drift refresh cool-off. */
export function resetDeviceDriftForTests() {
  lastDeviceDriftRefreshAt = 0;
  deviceDriftRefreshes = 0;
}

/** Test helper — how many device-list rebuilds topology drift has triggered. */
export function deviceDriftInfoForTests() {
  return { refreshes: deviceDriftRefreshes, lastRefreshAt: lastDeviceDriftRefreshAt };
}

async function getZoneGroupStateFromHousehold(m, probePrefs = {}) {
  const devices = Array.isArray(m?.Devices) ? m.Devices : [];
  if (!devices.length) {
    throw new Error("No Sonos devices available for topology.");
  }
  const preferHost =
    probePrefs.preferHost !== undefined ? probePrefs.preferHost : getSonosHost();
  const preferRoom =
    probePrefs.preferRoom !== undefined
      ? probePrefs.preferRoom
      : getSonosTargetRoom();
  const toTry = orderTopologyProbeDevices(devices, {
    preferHost,
    preferRoom,
  }).slice(0, ZONE_DEVICE_FAILOVER_LIMIT);
  let lastErr;
  for (let i = 0; i < toTry.length; i++) {
    const device = toTry[i];
    if (typeof device?.GetZoneGroupState !== "function") continue;
    try {
      const groups = await withTimeout(
        device.GetZoneGroupState(),
        ZONE_DEVICE_TIMEOUT_MS,
        `Sonos topology timed out after ${Math.ceil(ZONE_DEVICE_TIMEOUT_MS / 1000)}s`
      );
      markPlayerReachable(device);
      return groups;
    } catch (err) {
      lastErr = err;
      noteSpeakerFailure(device, err);
      const next = toTry[i + 1];
      if (next) {
        const from = device.Name || device.Host || `device[${i}]`;
        const toward = next.Name || next.Host || `device[${i + 1}]`;
        console.warn(
          `[sonos] topology via ${from} failed (${err?.message || err}); trying ${toward}`
        );
      }
    }
  }
  throw lastErr || new Error("Sonos topology query failed.");
}

export async function getZoneGroups(
  m,
  { fresh = false, preferHost, preferRoom } = {}
) {
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
      const groups = await getZoneGroupStateFromHousehold(m, {
        preferHost,
        preferRoom,
      });
      // clearZoneCache() bumps generation; never let a superseded read refill.
      if (readGeneration === zoneGeneration) {
        zoneCache = { at: Date.now(), groups };
      }
      // Safe to drop the manager here: this read's caller keeps using the
      // instance it already holds, and the rebuild happens on the next call.
      noteTopologyDeviceDrift(m, groups);
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
