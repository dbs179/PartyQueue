import { SonosManager } from "@svrooij/sonos";
import {
  configureSonosManagerHealth,
  noteSonosReadSuccess,
  noteSonosReadFailure,
  clearSonosUnhealthy,
} from "./sonos-manager-health.js";
import { formatZoneTopology, pickGroupByTarget } from "./sonos-queue-policy.js";
import { getSonosTargetRoom } from "./settings.js";
import { getSonosHost } from "./sonos-config.js";
import {
  isPlayerSkipped,
  isSonosUnreachableError,
  markPlayerReachable,
} from "./sonos-reachability.js";
import {
  noteSpeakerHealthFailure,
  SPEAKER_HEALTH_PROBE_TIMEOUT_MS,
  startSonosSpeakerHealthMonitor,
  stopSonosSpeakerHealthMonitor,
} from "./sonos-speaker-health.js";
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
 * Safety-net re-read of household groups. Event-driven refreshes (group
 * edits, 701/711/800) stay primary. This is intentionally infrequent.
 */
export const SONOS_TOPOLOGY_REFRESH_MS = 5 * 60_000;
/**
 * Ceiling on how stale a held group map may be before the next read refreshes
 * it. Bounded staleness, not a poll: inside this window every caller reuses
 * the cache, so one read covers all of them.
 *
 * This exists because a speaker can stay on the network and stop answering
 * SOAP, which moves coordination without refusing anything we send. Nothing
 * in that failure calls clearZoneCache(), so an unbounded cache can aim every
 * transport command at a box that is no longer the coordinator for the rest of
 * the night.
 */
export const ZONE_CACHE_MAX_AGE_MS = 30_000;

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

/** True when a household manager is already connected (no discovery). */
export function hasReadySonosManager() {
  return !!manager;
}

/**
 * Speakers the manager already knows. Never starts discovery — an empty list
 * means we have not connected yet.
 */
export function listManagedSonosDevices() {
  if (!manager) return [];
  try {
    // SonosManager.Devices throws while the device list is still empty.
    const devices = manager.Devices;
    return Array.isArray(devices) ? devices : [];
  } catch {
    return [];
  }
}

/**
 * Read-only GetTransportInfo, at most once a minute, and only for speakers
 * ordinary traffic has not already measured. Does not mark the skip map.
 * @returns {boolean} true when this call armed the timer
 */
export function startManagedSonosSpeakerHealthMonitor() {
  return startSonosSpeakerHealthMonitor({
    listDevices: listManagedSonosDevices,
    isCommunicationFailure: isSonosUnreachableError,
    readDevice: (device) =>
      withTimeout(
        device.AVTransportService.GetTransportInfo(),
        SPEAKER_HEALTH_PROBE_TIMEOUT_MS,
        "Sonos health probe timed out"
      ),
  });
}

export function stopManagedSonosSpeakerHealthMonitor() {
  stopSonosSpeakerHealthMonitor();
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
/**
 * The one topology SOAP chain on the wire, if any.
 * @type {null | {
 *   promise: Promise<unknown>,
 *   startedGeneration: number,
 *   ok: boolean,
 *   completedGeneration: number,
 *   error: unknown,
 * }}
 */
let zoneInFlight = null;
/** Bumped by clearZoneCache(). A read may fill the cache only for the generation it started in. */
let zoneGeneration = 0;
/**
 * Epoch ms. Set when a refresh failed and the last good map was kept, so an
 * aged-out cache does not start a fresh probe chain on every single call while
 * the household is unreachable. Explicit clears and fresh reads ignore it.
 */
let zoneRetryAfter = 0;

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
      // A topology probe timeout is not "this speaker is dead." Marking Office
      // unreachable here banned SetVolume for 60s and the DJ never ducked.
      // Record the miss for diagnostics only — do not touch the skip map.
      if (isSonosUnreachableError(err)) noteSpeakerHealthFailure(device, err);
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

/**
 * Start the single household topology read. The flight is published before
 * the SOAP call can yield, so a second caller cannot start another chain.
 * @param {object} m
 * @param {{ preferHost?: string, preferRoom?: string, quietFailure?: boolean, onKeptCache?: ((err: unknown) => void) | null }} opts
 * @param {number} startedGeneration
 */
function startTopologyRead(m, opts, startedGeneration) {
  const flight = {
    startedGeneration,
    ok: false,
    completedGeneration: startedGeneration,
    error: null,
    promise: /** @type {Promise<unknown>} */ (Promise.resolve()),
  };
  zoneInFlight = flight;
  flight.promise = (async () => {
    try {
      const groups = await getZoneGroupStateFromHousehold(m, {
        preferHost: opts.preferHost,
        preferRoom: opts.preferRoom,
      });
      flight.completedGeneration = zoneGeneration;
      flight.ok = true;
      // clearZoneCache() bumps generation; never let a superseded read refill.
      if (startedGeneration === zoneGeneration) {
        zoneCache = { at: Date.now(), groups };
      }
      // Safe to drop the manager here: this read's caller keeps using the
      // instance it already holds, and the rebuild happens on the next call.
      noteTopologyDeviceDrift(m, groups);
      return groups;
    } catch (err) {
      flight.ok = false;
      flight.error = err;
      flight.completedGeneration = zoneGeneration;
      // A failed refresh is not "we have no house." Keep the last map so
      // now-playing does not walk the failover list on a timer.
      if (zoneCache.groups) {
        // Hold off the next age-triggered probe. Without this, an aged cache
        // plus an unreachable household means every caller opens its own
        // failover chain.
        zoneRetryAfter = Date.now() + ZONE_CACHE_MAX_AGE_MS;
        if (typeof opts.onKeptCache === "function") opts.onKeptCache(err);
        if (!opts.quietFailure) {
          console.warn(
            `[sonos] topology refresh failed (${err?.message || err}); keeping last group map`
          );
        }
        return zoneCache.groups;
      }
      throw err;
    } finally {
      if (zoneInFlight === flight) zoneInFlight = null;
    }
  })();
  return flight;
}

/**
 * @param {{ promise: Promise<unknown> }} flight
 */
async function settleTopologyFlight(flight) {
  try {
    return { groups: await flight.promise, error: null };
  } catch (error) {
    return { groups: undefined, error };
  }
}

/**
 * A finished read is usable when it started in the generation the caller
 * needs and nothing invalidated the cache before it completed.
 * @param {{ ok: boolean, startedGeneration: number, completedGeneration: number }} flight
 * @param {number} requiredGeneration
 */
function topologyFlightUsable(flight, requiredGeneration) {
  return (
    flight.ok &&
    flight.completedGeneration === flight.startedGeneration &&
    flight.startedGeneration >= requiredGeneration
  );
}

/**
 * @param {object} m
 * @param {{ fresh?: boolean, preferHost?: string, preferRoom?: string, quietFailure?: boolean, onKeptCache?: ((err: unknown) => void) | null }} opts
 * @param {boolean} followedUp true after this caller already took its one post-stale read
 */
async function acquireTopology(m, opts, followedUp) {
  const required = zoneGeneration;
  let flight = zoneInFlight;
  let startedHere = false;

  // The active chain started before this caller was invalidated. Let it
  // finish, then share exactly one newer read. Do not open a second chain.
  if (flight && flight.startedGeneration < required) {
    await settleTopologyFlight(flight);
    if (followedUp) {
      if (zoneCache.groups) return zoneCache.groups;
      if (flight.error) throw flight.error;
      throw new Error("Sonos topology query failed.");
    }
    return acquireTopology(m, opts, true);
  }

  if (!flight) {
    flight = startTopologyRead(m, opts, zoneGeneration);
    startedHere = true;
  }

  const settled = await settleTopologyFlight(flight);
  if (topologyFlightUsable(flight, required)) return settled.groups;

  // The caller that opened this chain does not retry itself. A fresh waiter,
  // or anyone who still needs a post-invalidation map, gets one follow-up.
  const needsFollowUp = !!opts.fresh || flight.startedGeneration < required;
  if (startedHere || followedUp || !needsFollowUp) {
    if (settled.error && !zoneCache.groups) throw settled.error;
    return settled.groups;
  }
  return acquireTopology(m, opts, true);
}

export async function getZoneGroups(
  m,
  {
    fresh = false,
    preferHost,
    preferRoom,
    quietFailure = false,
    onKeptCache = null,
  } = {}
) {
  // Reuse the held map inside the staleness ceiling; past it, take one fresh
  // read. Now-playing still must not poll topology — the ceiling is long
  // enough that a read covers every caller in that window — and a failed read
  // keeps serving the last good map rather than throwing.
  if (!fresh && zoneCache.groups) {
    const now = Date.now();
    if (now - zoneCache.at < ZONE_CACHE_MAX_AGE_MS) return zoneCache.groups;
    if (now < zoneRetryAfter) return zoneCache.groups;
  }
  return acquireTopology(
    m,
    { fresh, preferHost, preferRoom, quietFailure, onKeptCache },
    false
  );
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

/**
 * Queue writes should retry once on either failure: 800 means this speaker
 * is no longer the coordinator, and 701/711 means the group moved under a
 * Play, Seek, or AddURI that was already in flight.
 */
export function isQueueWriteRefusal(err) {
  return isNotCoordinatorError(err) || isTransportRefusalError(err);
}

/** Play/Seek refusals when the coordinator changed under us (701/711). */
export function isTransportRefusalError(err) {
  const msg = String(err?.message ?? err ?? "");
  return (
    /\b701\b/.test(msg) ||
    /\b711\b/.test(msg) ||
    /Transition not available/i.test(msg) ||
    /Illegal seek target/i.test(msg)
  );
}

export function clearZoneCache() {
  zoneGeneration += 1;
  zoneCache = { at: 0, groups: null };
  zoneRetryAfter = 0;
  // Keep zoneInFlight. The SOAP call is still on the wire; forgetting it
  // here is what used to let a second GetZoneGroupState start. The generation
  // bump is what stops this read from refilling the cache.
}

/** Test helper — zone cache bookkeeping after clearZoneCache. */
export function zoneCacheInfoForTests() {
  return {
    generation: zoneGeneration,
    hasCache: !!zoneCache.groups,
    hasInFlight: !!zoneInFlight,
    ageMs: zoneCache.groups ? Date.now() - zoneCache.at : 0,
    retryHeldOff: Date.now() < zoneRetryAfter,
  };
}

/** Test helper — pretend the held map is this old. */
export function setZoneCacheAgeForTests(ageMs) {
  if (!zoneCache.groups) return;
  zoneCache = {
    ...zoneCache,
    at: Date.now() - Math.max(0, Number(ageMs) || 0),
  };
}

/** @type {ReturnType<typeof setInterval> | null} */
let topologyTimer = null;
/** @type {object | null} */
let topologyRefreshManager = null;
/** @type {(id: unknown) => void} */
let clearTopologyTimer = clearInterval;
/** Epoch ms. 0 until a periodic cycle actually starts a read. */
let lastTopologyRefreshAttempt = 0;
/** Epoch ms. 0 until a periodic read successfully commits the cache. */
let lastSuccessfulTopologyRefresh = 0;
let topologyFailureStreak = false;
let topologyFailureMessage = "";
/** @type {(line: string) => void} */
let logTopologyInfo = (line) => console.info(line);
/** @type {(line: string) => void} */
let logTopologyWarn = (line) => console.warn(line);

/**
 * Order-independent identity. Member order and object identity are not a
 * regroup. Coordinator, membership, and which groups exist are.
 * @param {unknown} groups
 */
function topologyFingerprint(groups) {
  if (!Array.isArray(groups)) return "";
  const idOf = (member) => String(member?.uuid || member?.host || member?.name || "");
  return groups
    .map((group) => {
      const members = Array.isArray(group?.members)
        ? group.members.map(idOf).filter(Boolean).sort()
        : [];
      return `${idOf(group?.coordinator)}[${members.join(",")}]`;
    })
    .sort()
    .join("|");
}

function notePeriodicTopologyFailure(err) {
  const message = String(err?.message || err || "topology refresh failed");
  if (topologyFailureStreak && message === topologyFailureMessage) return;
  topologyFailureStreak = true;
  topologyFailureMessage = message;
  const kept = zoneCache.groups ? "; keeping last group map" : "";
  logTopologyWarn(`[sonos] topology refresh failed (${message})${kept}`);
}

/**
 * One safety-net re-read. Shares zoneInFlight with every other topology read:
 * if one is already running, this cycle skips and does not queue.
 * Does not discover, regroup, or clear a good cache.
 * @param {{ manager?: object, now?: number }} [opts]
 */
export async function refreshCachedZoneTopology(opts = {}) {
  if (zoneInFlight) return { skipped: "overlap" };
  const m = opts.manager || manager;
  if (!m) return { skipped: "not-ready" };
  const now = opts.now || Date.now();
  // No activity gate: ordinary successful traffic says the coordinator we are
  // already talking to answers, not that the household is grouped the way we
  // last saw it. Suppressing on activity meant this never ran during a party.
  // zoneInFlight is set synchronously inside getZoneGroups, before this
  // function awaits, so a second cycle cannot start a stacked read.
  lastTopologyRefreshAttempt = now;
  const beforeGroups = zoneCache.groups;
  const beforeFp = topologyFingerprint(beforeGroups);
  const genBefore = zoneGeneration;
  let keptErr = null;
  try {
    await getZoneGroups(m, {
      fresh: true,
      quietFailure: true,
      onKeptCache(err) {
        keptErr = err;
      },
    });
  } catch (err) {
    notePeriodicTopologyFailure(err);
    return { ok: false, preserved: !!zoneCache.groups, changed: false };
  }
  if (keptErr) {
    notePeriodicTopologyFailure(keptErr);
    return { ok: false, preserved: true, changed: false };
  }
  if (zoneGeneration !== genBefore) {
    return { ok: true, superseded: true, changed: false };
  }
  lastSuccessfulTopologyRefresh = zoneCache.at || now;
  topologyFailureStreak = false;
  topologyFailureMessage = "";
  const changed = !!beforeGroups && beforeFp !== topologyFingerprint(zoneCache.groups);
  if (changed) {
    logTopologyInfo(
      `[sonos] topology changed: ${formatZoneTopology(beforeGroups)} -> ${formatZoneTopology(zoneCache.groups)}`
    );
  }
  return { ok: true, changed, preserved: false };
}

/**
 * Arm the safety-net timer. A second call does not add another timer.
 * Ticks do nothing until a Sonos manager already exists, and they do not
 * start discovery. The first read waits one full interval.
 * @param {{
 *   setInterval?: typeof setInterval,
 *   clearInterval?: typeof clearInterval,
 *   intervalMs?: number,
 *   manager?: object,
 *   now?: () => number,
 * }} [deps]
 * @returns {boolean} true when this call armed the timer
 */
export function startPeriodicZoneTopologyRefresh(deps = {}) {
  if (topologyTimer) return false;
  clearTopologyTimer = deps.clearInterval || clearInterval;
  topologyRefreshManager = deps.manager || null;
  const setInt = deps.setInterval || setInterval;
  const ms = deps.intervalMs || SONOS_TOPOLOGY_REFRESH_MS;
  topologyTimer = setInt(() => {
    if (zoneInFlight) return;
    const tickOpts = {};
    if (topologyRefreshManager) tickOpts.manager = topologyRefreshManager;
    if (typeof deps.now === "function") tickOpts.now = deps.now();
    void refreshCachedZoneTopology(tickOpts).catch(() => {
      /* a refresh must not take the process down */
    });
  }, ms);
  topologyTimer.unref?.();
  return true;
}

export function stopPeriodicZoneTopologyRefresh() {
  if (topologyTimer) {
    try {
      clearTopologyTimer(topologyTimer);
    } catch {
      /* a test double is not a real timer */
    }
  }
  topologyTimer = null;
  topologyRefreshManager = null;
  clearTopologyTimer = clearInterval;
}

export function zoneTopologyRefreshInfo() {
  return {
    lastTopologyRefreshAttempt,
    lastSuccessfulTopologyRefresh,
    armed: !!topologyTimer,
    inFlight: !!zoneInFlight,
  };
}

/**
 * @param {{ info?: (line: string) => void, warn?: (line: string) => void }} [fns]
 */
export function setZoneTopologyLoggerForTests(fns = {}) {
  logTopologyInfo = typeof fns.info === "function" ? fns.info : (line) => console.info(line);
  logTopologyWarn = typeof fns.warn === "function" ? fns.warn : (line) => console.warn(line);
}

export function resetZoneTopologyRefreshForTests() {
  stopPeriodicZoneTopologyRefresh();
  lastTopologyRefreshAttempt = 0;
  lastSuccessfulTopologyRefresh = 0;
  topologyFailureStreak = false;
  topologyFailureMessage = "";
  logTopologyInfo = (line) => console.info(line);
  logTopologyWarn = (line) => console.warn(line);
}
