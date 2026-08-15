// Guest-facing fairness snapshot: remaining song + Set Request allowances.
// Pure helpers so the UI and GET /api/fairness share one shape.

import { sanitizeDisplayName } from "./display-name.js";
import {
  evaluateRequestFairness,
  liveQueueRequesterKey,
} from "./request-fairness.js";
import { evaluateSetRequestFairness } from "./set-request-fairness.js";

const PROBE_TARGET = {
  uri: "spotify:track:0000000000000000000000",
  name: "Fairness Status Probe",
  artist: "PartyQueue",
};

function remainingOf(max, count) {
  const m = Math.max(0, Math.floor(Number(max) || 0));
  const c = Math.max(0, Math.floor(Number(count) || 0));
  return Math.max(0, m - c);
}

function userKey(value) {
  return String(sanitizeDisplayName(value) || "").toLocaleLowerCase();
}

function countUpcomingForUser(queue, user) {
  const key = userKey(user);
  if (!key || !Array.isArray(queue)) {
    return { upcomingCount: 0, totalRequestedUpcoming: 0 };
  }
  let upcomingCount = 0;
  let totalRequestedUpcoming = 0;
  for (const track of queue) {
    if (!track?.searched || track?.setRequest) continue;
    totalRequestedUpcoming += 1;
    if (liveQueueRequesterKey(track) === key) upcomingCount += 1;
  }
  return { upcomingCount, totalRequestedUpcoming };
}

/**
 * @param {{
 *   user?: string,
 *   songSettings?: object,
 *   setSettings?: object,
 *   queue?: unknown[],
 *   events?: unknown[],
 *   fairnessResetAt?: number,
 *   now?: number,
 * }} [opts]
 */
export function buildGuestFairnessStatus({
  user,
  songSettings = {},
  setSettings = {},
  queue = [],
  events = [],
  fairnessResetAt = 0,
  now = Date.now(),
} = {}) {
  const displayUser = sanitizeDisplayName(user) || "";
  const songEnabled = !!songSettings.requestFairnessEnabled;
  const setEnabled = !!setSettings.setRequestFairnessEnabled;

  /** @type {object} */
  let song = { enabled: false };
  if (songEnabled) {
    if (!displayUser) {
      song = { enabled: true, needsName: true };
    } else {
      const rollingMax = Math.max(
        1,
        Math.floor(Number(songSettings.requestFairnessRollingMax) || 1)
      );
      const upcomingCap = Math.max(
        1,
        Math.floor(Number(songSettings.requestFairnessUpcomingCap) || 1)
      );
      const upcomingThreshold = Math.max(
        1,
        Math.floor(Number(songSettings.requestFairnessUpcomingThreshold) || 1)
      );
      const windowMinutes = Math.max(
        1,
        Math.floor(Number(songSettings.requestFairnessWindowMinutes) || 1)
      );

      // Ignore upcoming-cap so we always get rolling usage for the status line.
      const rollingDecision = evaluateRequestFairness({
        settings: {
          ...songSettings,
          requestFairnessUpcomingThreshold: 10_000,
          requestFairnessUpcomingCap: 10_000,
        },
        user: displayUser,
        queue,
        events,
        target: PROBE_TARGET,
        fairnessResetAt,
        now,
      });
      const gateDecision = evaluateRequestFairness({
        settings: songSettings,
        user: displayUser,
        queue,
        events,
        target: PROBE_TARGET,
        fairnessResetAt,
        now,
      });

      const rollingCount = Number(rollingDecision.rollingCount) || 0;
      const { upcomingCount, totalRequestedUpcoming } = countUpcomingForUser(
        queue,
        displayUser
      );
      const limitsActive = !!gateDecision.limitsActive;
      const upcomingActive = limitsActive;

      song = {
        enabled: true,
        needsName: false,
        canRequest: !!gateDecision.allowed,
        code: gateDecision.allowed ? null : gateDecision.code || null,
        limitsActive,
        uniqueRequesters: Number(gateDecision.uniqueRequesters) || 0,
        rollingCount,
        rollingMax,
        rollingRemaining: remainingOf(rollingMax, rollingCount),
        windowMinutes,
        retryAt: gateDecision.retryAt || rollingDecision.retryAt || null,
        retryAfterSec:
          gateDecision.retryAfterSec || rollingDecision.retryAfterSec || null,
        upcomingActive,
        upcomingCount,
        upcomingCap,
        upcomingRemaining: remainingOf(upcomingCap, upcomingCount),
        upcomingThreshold,
        totalRequestedUpcoming,
      };
    }
  }

  /** @type {object} */
  let setRequest = { enabled: false };
  if (setEnabled) {
    if (!displayUser) {
      setRequest = { enabled: true, needsName: true };
    } else {
      const decision = evaluateSetRequestFairness({
        settings: {
          ...setSettings,
          requestFairnessHostBypass: songSettings.requestFairnessHostBypass,
        },
        user: displayUser,
        events,
        fairnessResetAt,
        now,
      });
      const rollingMax = Math.max(
        1,
        Math.floor(Number(setSettings.setRequestFairnessMax) || 1)
      );
      const windowMinutes = Math.max(
        1,
        Math.floor(Number(setSettings.setRequestFairnessWindowMinutes) || 1)
      );
      const rollingCount = Number(decision.rollingCount) || 0;
      setRequest = {
        enabled: true,
        needsName: false,
        canRequest: !!decision.allowed,
        code: decision.allowed ? null : decision.code || null,
        rollingCount,
        rollingMax,
        rollingRemaining: remainingOf(rollingMax, rollingCount),
        windowMinutes,
        retryAt: decision.retryAt || null,
        retryAfterSec: decision.retryAfterSec || null,
      };
    }
  }

  return {
    user: displayUser,
    song,
    setRequest,
    active: songEnabled || setEnabled,
  };
}
