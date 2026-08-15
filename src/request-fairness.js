import { sanitizeDisplayName } from "./display-name.js";
import { spotifyTrackId } from "./sampler.js";
import { songMatchKey } from "./sonos.js";

let fairnessTail = Promise.resolve();

// Serialize guest add policy checks through the successful request-log write.
// Sonos already serializes queue mutations; this closes the smaller window
// where two simultaneous requests could both pass the same rolling quota.
export function withRequestFairnessLock(fn) {
  const run = fairnessTail.then(fn, fn);
  fairnessTail = run.catch(() => {});
  return run;
}

/** Caps stay off until this many distinct Users have requested recently. */
export const REQUEST_FAIRNESS_MIN_USERS = 2;

const userKey = (value) =>
  String(sanitizeDisplayName(value) || "").toLocaleLowerCase();

/** Live queue identity: User first, then badge, so legacy rows still count. */
export function liveQueueRequesterKey(track) {
  return userKey(track?.requestedByUser || track?.requestedBy);
}

function isSongRequestEvent(event) {
  return event?.kind !== "setRequest" && event?.kind !== "setTrack";
}

function recentSongRequestEvents(events, { key = "", resetAt, now, windowMs }) {
  return (Array.isArray(events) ? events : [])
    .filter(
      (event) =>
        isSongRequestEvent(event) &&
        (!key || userKey(event?.requestedBy) === key) &&
        Number(event?.ts) > resetAt &&
        Number(event?.ts) > now - windowMs &&
        Number(event?.ts) <= now
    )
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

function uniqueRequesterCount({
  queue,
  events,
  user,
  resetAt,
  now,
  windowMs,
}) {
  const users = new Set();
  const incoming = userKey(user);
  if (incoming) users.add(incoming);
  for (const track of Array.isArray(queue) ? queue : []) {
    if (!track?.searched || track?.setRequest) continue;
    const key = liveQueueRequesterKey(track);
    if (key) users.add(key);
  }
  for (const event of recentSongRequestEvents(events, { resetAt, now, windowMs })) {
    const key = userKey(event?.requestedBy);
    if (key) users.add(key);
  }
  return users.size;
}

function sameRequestedTrack(track, target, force) {
  const targetId = spotifyTrackId(target.uri);
  const trackId = spotifyTrackId(track?.uri);
  if (targetId && trackId === targetId) return true;
  if (force) return false;
  const targetKey = songMatchKey(target.name, target.artist);
  return (
    !!targetKey &&
    songMatchKey(track?.title || track?.name, track?.artist) === targetKey
  );
}

/**
 * Pure request-policy decision. Queue tracks must be the upcoming queue only;
 * the currently playing song therefore never consumes an upcoming slot.
 */
export function evaluateRequestFairness({
  settings,
  user,
  queue = [],
  events = [],
  target = {},
  force = false,
  hostAuthenticated = false,
  fairnessResetAt = 0,
  now = Date.now(),
} = {}) {
  const policy = settings || {};
  if (!policy.requestFairnessEnabled) {
    return { allowed: true, requestCreated: true };
  }
  if (hostAuthenticated && policy.requestFairnessHostBypass) {
    return { allowed: true, requestCreated: true, hostBypass: true };
  }

  const key = userKey(user);
  if (!key) {
    return {
      allowed: false,
      status: 400,
      code: "name_required",
      error: "Enter your name before adding a song.",
    };
  }
  const resetAt = Math.max(0, Math.floor(Number(fairnessResetAt) || 0));

  const upcoming = Array.isArray(queue) ? queue : [];
  const existing = upcoming.find((track) =>
    sameRequestedTrack(track, target, !!force)
  );
  if (existing?.searched) {
    return {
      allowed: true,
      requestCreated: false,
      alreadyRequested: true,
    };
  }

  const upcomingCap = Math.max(
    1,
    Math.floor(Number(policy.requestFairnessUpcomingCap) || 1)
  );
  const upcomingThreshold = Math.max(
    1,
    Math.floor(Number(policy.requestFairnessUpcomingThreshold) || 1)
  );
  const totalRequestedUpcoming = upcoming.filter(
    (track) => track?.searched && !track?.setRequest
  ).length;
  const upcomingCount = upcoming.filter(
    (track) =>
      track?.searched &&
      !track?.setRequest &&
      liveQueueRequesterKey(track) === key
  ).length;

  const rollingMax = Math.max(
    1,
    Math.floor(Number(policy.requestFairnessRollingMax) || 1)
  );
  const windowMinutes = Math.max(
    1,
    Math.floor(Number(policy.requestFairnessWindowMinutes) || 1)
  );
  const windowMs = windowMinutes * 60_000;
  const uniqueRequesters = uniqueRequesterCount({
    queue: upcoming,
    events,
    user,
    resetAt,
    now,
    windowMs,
  });
  const recent = recentSongRequestEvents(events, {
    key,
    resetAt,
    now,
    windowMs,
  });
  // Solo loaders stay unlimited. Caps turn on once a second person has
  // requested (waiting queue or rolling window) and enough requested songs
  // are waiting; they turn back off when the waiting list drains.
  const limitsActive =
    uniqueRequesters >= REQUEST_FAIRNESS_MIN_USERS &&
    totalRequestedUpcoming >= upcomingThreshold;

  if (limitsActive && upcomingCount >= upcomingCap) {
    return {
      allowed: false,
      status: 409,
      code: "upcoming_cap",
      limitsActive,
      uniqueRequesters,
      totalRequestedUpcoming,
      upcomingThreshold,
      upcomingCount,
      upcomingCap,
      error: `There are ${totalRequestedUpcoming} requested songs waiting, and you already have ${upcomingCap} song${
        upcomingCap === 1 ? "" : "s"
      } coming up. Wait for one to start or be removed.`,
    };
  }

  if (limitsActive && recent.length >= rollingMax) {
    const retryAt = Number(recent[recent.length - rollingMax]?.ts) + windowMs;
    const retryAfterSec = Math.max(1, Math.ceil((retryAt - now) / 1000));
    const retryMinutes = Math.max(1, Math.ceil(retryAfterSec / 60));
    return {
      allowed: false,
      status: 429,
      code: "rolling_quota",
      limitsActive,
      uniqueRequesters,
      rollingCount: recent.length,
      rollingMax,
      windowMinutes,
      retryAt,
      retryAfterSec,
      error: `You’ve reached ${rollingMax} request${
        rollingMax === 1 ? "" : "s"
      } per ${windowMinutes} minutes. Try again in about ${retryMinutes} minute${
        retryMinutes === 1 ? "" : "s"
      }.`,
    };
  }

  return {
    allowed: true,
    requestCreated: true,
    limitsActive,
    uniqueRequesters,
    totalRequestedUpcoming,
    upcomingThreshold,
    upcomingCount,
    upcomingCap,
    rollingCount: recent.length,
    rollingMax,
  };
}

