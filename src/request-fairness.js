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

const userKey = (value) =>
  String(sanitizeDisplayName(value) || "").toLocaleLowerCase();

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
      userKey(track.requestedByUser) === key
  ).length;
  if (
    totalRequestedUpcoming >= upcomingThreshold &&
    upcomingCount >= upcomingCap
  ) {
    return {
      allowed: false,
      status: 409,
      code: "upcoming_cap",
      totalRequestedUpcoming,
      upcomingThreshold,
      upcomingCount,
      upcomingCap,
      error: `There are ${totalRequestedUpcoming} requested songs waiting, and you already have ${upcomingCap} song${
        upcomingCap === 1 ? "" : "s"
      } coming up. Wait for one to start or be removed.`,
    };
  }

  const rollingMax = Math.max(
    1,
    Math.floor(Number(policy.requestFairnessRollingMax) || 1)
  );
  const windowMinutes = Math.max(
    1,
    Math.floor(Number(policy.requestFairnessWindowMinutes) || 1)
  );
  const windowMs = windowMinutes * 60_000;
  const recent = (Array.isArray(events) ? events : [])
    .filter(
      (event) =>
        // Set Request ledger rows never consume song-request rolling quota.
        event?.kind !== "setRequest" &&
        event?.kind !== "setTrack" &&
        userKey(event?.requestedBy) === key &&
        Number(event?.ts) > now - windowMs &&
        Number(event?.ts) <= now
    )
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  if (recent.length >= rollingMax) {
    const retryAt = Number(recent[recent.length - rollingMax]?.ts) + windowMs;
    const retryAfterSec = Math.max(1, Math.ceil((retryAt - now) / 1000));
    const retryMinutes = Math.max(1, Math.ceil(retryAfterSec / 60));
    return {
      allowed: false,
      status: 429,
      code: "rolling_quota",
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
    totalRequestedUpcoming,
    upcomingThreshold,
    upcomingCount,
    upcomingCap,
    rollingCount: recent.length,
    rollingMax,
  };
}

