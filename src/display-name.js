// Guest display names for party requests (no accounts).
// Client stores the chosen name in localStorage; server sanitizes on ingest.

export const DISPLAY_NAME_MAX = 24;
export const DEDICATION_MAX = 60;

/** Trim, strip control chars, cap length. Empty → null. */
export function sanitizeDisplayName(value) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, DISPLAY_NAME_MAX);
  return cleaned || null;
}

/** Optional short dedication shown on the queue badge. Empty → null. */
export function sanitizeDedication(value) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, DEDICATION_MAX);
  return cleaned || null;
}

/**
 * Split guest badge alias vs stable User for stats/shouts.
 * Old clients send only `requestedBy` → used as both.
 * Empty alias falls back to User for badges.
 * @returns {{ user: string|null, badge: string|null, alias: string|null }}
 */
/** Case-insensitive compare of two sanitized display names. */
export function sameDisplayName(a, b) {
  const left = sanitizeDisplayName(a);
  const right = sanitizeDisplayName(b);
  if (!left || !right) return false;
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Queue alias only when it differs from the User (Maria / Mia, not Dave / Dave).
 * @returns {string|null}
 */
export function distinctRequesterAlias(user, alias) {
  const cleaned = sanitizeDisplayName(alias);
  if (!cleaned || sameDisplayName(user, cleaned)) return null;
  return cleaned;
}

export function resolveGuestIdentity({ requestedBy, requestedByUser } = {}) {
  const alias = sanitizeDisplayName(requestedBy);
  const userIn = sanitizeDisplayName(requestedByUser);
  const user = userIn || alias;
  const badge = alias || user;
  return { user, badge, alias };
}
