/** Sonos player-type catalog for room icons (Arc, Play 1, …). */

export const SONOS_PLAYER_TYPE_IDS = [
  "arc",
  "play1",
  "amp",
  "roam",
  "move",
  "connect",
];

export const SONOS_PLAYER_TYPE_LABELS = {
  arc: "Sonos Arc",
  play1: "Sonos Play 1",
  amp: "Sonos Amp",
  roam: "Sonos Roam",
  move: "Sonos Move",
  connect: "Sonos Connect",
};

export const DEFAULT_SONOS_PLAYER_TYPE = "default";
export const GROUP_SONOS_ICON = "group";

const TYPE_SET = new Set(SONOS_PLAYER_TYPE_IDS);

/** @param {unknown} value */
export function normalizeSonosPlayerType(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return TYPE_SET.has(id) ? id : null;
}

/**
 * Case-insensitive lookup; returns assignable type or null if unset/unknown.
 * @param {Record<string, string>|null|undefined} map
 * @param {string} room
 */
export function lookupSonosPlayerType(map, room) {
  const name = typeof room === "string" ? room.trim() : "";
  if (!name || !map || typeof map !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(map, name)) {
    return normalizeSonosPlayerType(map[name]);
  }
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (String(k).toLowerCase() === key) return normalizeSonosPlayerType(v);
  }
  return null;
}

/**
 * Icon id for a zone group chip: shared group icon when multi-member.
 * @param {{ memberCount?: number, members?: string[], coordinator?: string }} group
 * @param {Record<string, string>|null|undefined} typeMap
 */
export function iconForSonosGroup(group, typeMap) {
  const members = Array.isArray(group?.members) ? group.members.filter(Boolean) : [];
  const count = Number(group?.memberCount) || members.length;
  if (count > 1) return GROUP_SONOS_ICON;
  const room = members[0] || group?.coordinator || "";
  return lookupSonosPlayerType(typeMap, room) || DEFAULT_SONOS_PLAYER_TYPE;
}
