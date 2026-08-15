// Who requested a searched track — persist User + distinct alias so Memory
// can say "Maria · Mia" after live queue-origin is consumed.

import {
  distinctRequesterAlias,
  sameDisplayName,
  sanitizeDisplayName,
} from "./display-name.js";
import { requestedByOf, requestedByUserOf } from "./queue-origin.js";
import { latestRequesterIdentityOf } from "./request-log.js";

/**
 * @param {string|null|undefined} id
 * @param {{ requestedBy?: string|null, alias?: string|null }} [stored]
 * @returns {{ requestedBy: string|null, alias: string|null }}
 */
export function memoryRequesterIdentityOf(id, stored = {}) {
  const storedUser = sanitizeDisplayName(stored?.requestedBy);
  const storedAlias = distinctRequesterAlias(storedUser, stored?.alias);
  const key = String(id || "").trim();
  if (!key) {
    return { requestedBy: storedUser, alias: storedAlias };
  }

  const liveUser = sanitizeDisplayName(requestedByUserOf(key));
  const liveBadge = sanitizeDisplayName(requestedByOf(key));
  const liveAlias = distinctRequesterAlias(liveUser, liveBadge);
  const logged = latestRequesterIdentityOf(key);
  const logUser = logged?.requestedBy || null;
  const logAlias = logged?.alias || null;

  // Legacy Memory rows sometimes stored the alias as requestedBy (Mia).
  let user = storedUser;
  if (
    user &&
    ((logUser && sameDisplayName(user, logAlias) && !sameDisplayName(user, logUser)) ||
      (liveUser && sameDisplayName(user, liveAlias) && !sameDisplayName(user, liveUser)))
  ) {
    user = logUser || liveUser;
  }
  if (!user) user = liveUser || logUser || liveBadge || logAlias;

  const alias = distinctRequesterAlias(
    user,
    storedAlias || liveAlias || logAlias
  );
  return { requestedBy: user || null, alias };
}

/** User only — tests and callers that do not need the alias. */
export function memoryRequesterOf(id, stored = null) {
  const existing =
    stored && typeof stored === "object"
      ? stored.requestedBy
      : stored;
  return memoryRequesterIdentityOf(id, {
    requestedBy: existing,
    alias: stored && typeof stored === "object" ? stored.alias : null,
  }).requestedBy;
}
