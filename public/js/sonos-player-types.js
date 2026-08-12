/** Client catalog + helpers for Sonos player-type icons. */

export const SONOS_PLAYER_TYPES = [
  { id: "arc", label: "Sonos Arc" },
  { id: "play1", label: "Sonos Play 1" },
  { id: "amp", label: "Sonos Amp" },
  { id: "roam", label: "Sonos Roam" },
  { id: "move", label: "Sonos Move" },
  { id: "connect", label: "Sonos Connect" },
];

export const DEFAULT_SONOS_PLAYER_TYPE = "default";
export const GROUP_SONOS_ICON = "group";

const TYPE_SET = new Set(SONOS_PLAYER_TYPES.map((t) => t.id));

/** @param {unknown} value */
export function normalizeSonosPlayerType(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return TYPE_SET.has(id) ? id : null;
}

/** Bump when SVG art changes so clients don’t keep a stale icon. */
const SONOS_ICON_REV = "2";

/** @param {string|null|undefined} typeId */
export function sonosIconUrl(typeId) {
  const id =
    typeId === GROUP_SONOS_ICON
      ? GROUP_SONOS_ICON
      : normalizeSonosPlayerType(typeId) || DEFAULT_SONOS_PLAYER_TYPE;
  return `/sonos-icons/${id}.svg?v=${SONOS_ICON_REV}`;
}

/**
 * @param {{
 *   memberCount?: number,
 *   members?: string[],
 *   coordinator?: string,
 *   icon?: string,
 * }} group
 * @param {Array<{ name?: string, playerType?: string }>} [speakers]
 */
export function iconForGroupChip(group, speakers = []) {
  const members = Array.isArray(group?.members)
    ? group.members.filter(Boolean)
    : [];
  const count = Number(group?.memberCount) || members.length;
  if (count > 1 || group?.icon === GROUP_SONOS_ICON) return GROUP_SONOS_ICON;

  const room = members[0] || group?.coordinator || "";
  const roomKey = String(room || "").toLowerCase();
  const fromSpeaker = speakers.find(
    (s) => String(s?.name || "").toLowerCase() === roomKey
  );
  // Prefer live speaker assignment over a possibly stale group.icon from the API.
  const fromType = normalizeSonosPlayerType(fromSpeaker?.playerType);
  if (fromType) return fromType;

  if (group?.icon && group.icon !== GROUP_SONOS_ICON) {
    return normalizeSonosPlayerType(group.icon) || DEFAULT_SONOS_PLAYER_TYPE;
  }
  return DEFAULT_SONOS_PLAYER_TYPE;
}

/** @param {{ playerType?: string }|null|undefined} speaker */
export function iconForSpeakerChip(speaker) {
  return (
    normalizeSonosPlayerType(speaker?.playerType) || DEFAULT_SONOS_PLAYER_TYPE
  );
}
