const DISPLAY_NAME_KEY = "pq.displayName"; // stable User (real name)
const DISPLAY_ALIAS_KEY = "pq.displayAlias"; // mutable badge alias
export const DISPLAY_NAME_MAX = 24;
export const DEDICATION_MAX = 60;

export function sanitizeDisplayName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, DISPLAY_NAME_MAX);
}

export function sanitizeDedication(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, DEDICATION_MAX);
}

/** Queue / NP label: "For Sarah from Mark" */
export function dedicationDisplayLabel(dedication, requester) {
  const forWho = sanitizeDedication(dedication || "");
  if (!forWho) return "";
  const by = sanitizeDisplayName(requester || "");
  const core = /^for\s+/i.test(forWho) ? forWho : `For ${forWho}`;
  return by ? `${core} from ${by}` : core;
}

export function getDisplayName() {
  try {
    return sanitizeDisplayName(localStorage.getItem(DISPLAY_NAME_KEY) || "");
  } catch {
    return "";
  }
}

export function getDisplayAlias() {
  try {
    return sanitizeDisplayName(localStorage.getItem(DISPLAY_ALIAS_KEY) || "");
  } catch {
    return "";
  }
}

export function setDisplayName(name) {
  const cleaned = sanitizeDisplayName(name);
  if (!cleaned) return false;
  try {
    localStorage.setItem(DISPLAY_NAME_KEY, cleaned);
  } catch {
    /* private mode / quota — still allow session via in-memory fallback */
  }
  return true;
}

export function setDisplayAlias(alias) {
  const cleaned = sanitizeDisplayName(alias);
  try {
    if (cleaned) localStorage.setItem(DISPLAY_ALIAS_KEY, cleaned);
    else localStorage.removeItem(DISPLAY_ALIAS_KEY);
  } catch {
    /* private mode / quota */
  }
  return true;
}

/** Badge / “Searched by” label: alias if set, else User. */
export function guestBadgeName(sessionDisplayName, sessionDisplayAlias) {
  return sessionDisplayAlias || sessionDisplayName || "";
}

/** Payload fields for queue / suggestion APIs. */
export function guestIdentityPayload(sessionDisplayName, sessionDisplayAlias) {
  const user = sessionDisplayName || "";
  const alias = sessionDisplayAlias || "";
  return {
    requestedBy: alias || user,
    requestedByUser: user,
  };
}
