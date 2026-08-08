/**
 * Set Request fairness — independent of individual song-request quotas.
 * Default: 1 set per 60 minutes when enabled.
 */

import { sanitizeDisplayName } from "./display-name.js";

const userKey = (value) =>
  String(sanitizeDisplayName(value) || "").toLocaleLowerCase();

/**
 * @param {{
 *   settings?: {
 *     setRequestFairnessEnabled?: boolean,
 *     setRequestFairnessMax?: number,
 *     setRequestFairnessWindowMinutes?: number,
 *     requestFairnessHostBypass?: boolean,
 *   },
 *   user?: string,
 *   events?: Array<{ kind?: string, requestedBy?: string, ts?: number }>,
 *   hostAuthenticated?: boolean,
 *   now?: number,
 * }} [opts]
 */
export function evaluateSetRequestFairness({
  settings,
  user,
  events = [],
  hostAuthenticated = false,
  now = Date.now(),
} = {}) {
  const policy = settings || {};
  if (!policy.setRequestFairnessEnabled) {
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
      error: "Enter your name before requesting a set.",
    };
  }

  const rollingMax = Math.max(
    1,
    Math.floor(Number(policy.setRequestFairnessMax) || 1)
  );
  const windowMinutes = Math.max(
    1,
    Math.floor(Number(policy.setRequestFairnessWindowMinutes) || 1)
  );
  const windowMs = windowMinutes * 60_000;
  const recent = (Array.isArray(events) ? events : [])
    .filter(
      (event) =>
        event?.kind === "setRequest" &&
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
      code: "set_request_quota",
      rollingCount: recent.length,
      rollingMax,
      windowMinutes,
      retryAt,
      retryAfterSec,
      error: `You’ve reached ${rollingMax} Set Request${
        rollingMax === 1 ? "" : "s"
      } per ${windowMinutes} minutes. Try again in about ${retryMinutes} minute${
        retryMinutes === 1 ? "" : "s"
      }.`,
    };
  }

  return {
    allowed: true,
    requestCreated: true,
    rollingCount: recent.length,
    rollingMax,
    windowMinutes,
  };
}
