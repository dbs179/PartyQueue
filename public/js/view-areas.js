/** Pure view-name classifiers for routing and host PIN gating. */

/** Settings hub + nested settings-* pages. */
export function isSettingsArea(name) {
  return name === "settings" || String(name || "").startsWith("settings-");
}

/** Song Selection / mix pages that share the mix toolbar chrome. */
export function isMusicMixArea(name) {
  return (
    name === "mix" ||
    name === "mood-presets" ||
    name === "genres" ||
    name === "playlists"
  );
}

/**
 * Everything behind the DJ Booth — the hub itself plus every page it links to
 * (Look, Queue, DJ, Users, Connections, Reset, Memory, Suggestions). All of it
 * asks for the host PIN when one is configured.
 */
export function isHostArea(name) {
  return (
    name === "booth" ||
    name === "memory" ||
    name === "suggestions" ||
    isSettingsArea(name)
  );
}
