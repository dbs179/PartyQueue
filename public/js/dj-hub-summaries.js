/** Pure DJ Booth hub summary line formatters (no DOM). */

/**
 * @param {string|null|undefined} name
 * @param {number} [maxLen]
 */
export function formatDjIconLabel(name, maxLen = 28) {
  if (!name) return "Default";
  const base = String(name)
    .replace(/\.[^.]+$/, "")
    .replace(/^dj-icon-(?:\d+-)?/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  const label = base || String(name);
  const limit = Math.max(1, Math.floor(Number(maxLen) || 28));
  return label.length > limit ? `${label.slice(0, limit - 1)}…` : label;
}

/**
 * @param {{
 *   intensity?: string|null,
 *   provider?: string|null,
 *   speed?: number|string|null,
 * }} [opts]
 */
export function formatDjVoiceHubLine({
  intensity = "classic",
  provider = "elevenlabs_ha",
  speed = 1,
} = {}) {
  const raw = String(intensity || "classic");
  const intensityLabel = raw.charAt(0).toUpperCase() + raw.slice(1);
  const providerLabel =
    String(provider || "elevenlabs_ha") === "openai_ha"
      ? "OpenAI"
      : "ElevenLabs";
  const n = Number(speed);
  const speedLabel = Number.isFinite(n) ? `${n}×` : "1×";
  return `${intensityLabel} · ${providerLabel} · ${speedLabel}`;
}

/**
 * @param {{
 *   personaNotes?: string|null,
 *   alwaysInstructions?: string|null,
 *   neverInstructions?: string|null,
 *   pronunciations?: string|null,
 * }} [opts]
 */
export function formatDjAdvancedHubLine({
  personaNotes = "",
  alwaysInstructions = "",
  neverInstructions = "",
  pronunciations = "",
} = {}) {
  const customSections = [personaNotes, alwaysInstructions, neverInstructions]
    .filter((value) => String(value || "").trim()).length;
  const pronunciationCount = String(pronunciations || "")
    .split(/\r?\n/)
    .filter((line) => /(?:=>|=)/.test(line)).length;
  return customSections || pronunciationCount
    ? `${customSections} guidance · ${pronunciationCount} pronunciations`
    : "Core locked";
}

/**
 * @param {{
 *   low?: string|number|null,
 *   mid?: string|number|null,
 *   high?: string|number|null,
 *   silence?: string|number|null,
 * }} [opts]
 */
export function formatDjVolumeHubLine({
  low = "—",
  mid = "—",
  high = "—",
  silence = "—",
} = {}) {
  return `${low}/${mid}/${high}% · ${silence}s`;
}

/**
 * @param {{
 *   mode?: string|null,
 *   everyN?: string|number|null,
 *   percent?: string|number|null,
 * }} [opts]
 */
export function formatDjShoutsHubLine({
  mode = "every",
  everyN = "5",
  percent = "25",
} = {}) {
  if (String(mode || "every") === "every") {
    return `Every ${everyN ?? "5"}`;
  }
  return `${percent ?? "25"}% of the time`;
}

/**
 * @param {string[]|string|null|undefined} lines
 */
export function formatDjTaglinesHubLine(lines) {
  let n = 0;
  if (Array.isArray(lines)) {
    n = lines.filter((line) => String(line || "").trim()).length;
  } else {
    n = String(lines || "")
      .split(/\r?\n/)
      .filter((line) => line.trim()).length;
  }
  return n === 1 ? "1 line" : `${n} lines`;
}

/**
 * @param {{
 *   mode?: string|null,
 *   mixHr?: string|number|null,
 *   banter?: string|number|null,
 * }} [opts]
 */
export function formatDjRosterHubLine({
  mode = "holy-roller",
  mixHr = 70,
  banter = 15,
} = {}) {
  const id = String(mode || "holy-roller").trim().toLowerCase();
  if (id === "sister-static") return "Sister Static";
  if (id === "mix") {
    const hr = Number(mixHr);
    const hrPct = Number.isFinite(hr) ? Math.max(0, Math.min(100, Math.round(hr))) : 70;
    const ssPct = 100 - hrPct;
    const b = Number(banter);
    const bPct = Number.isFinite(b) ? Math.max(0, Math.min(100, Math.round(b))) : 15;
    return `Mix · ${hrPct}/${ssPct} · Banter ${bPct}%`;
  }
  return "Holy Roller";
}

/**
 * @param {string|null|undefined} title
 * @param {number} [maxLen]
 */
export function formatDjLastCallHubLine(title, maxLen = 22) {
  const text = String(title || "Closing Time").trim() || "Closing Time";
  const limit = Math.max(1, Math.floor(Number(maxLen) || 22));
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 2))}…` : text;
}

/**
 * @param {{
 *   name?: string|null,
 *   artist?: string|null,
 *   uri?: string|null,
 * }} track
 */
export function formatEndOfNightLabel(track = {}) {
  const name = String(track.name || "Closing Time").trim() || "Closing Time";
  const artist = String(track.artist || "").trim();
  const label = artist ? `${name} — ${artist}` : name;
  return track.uri ? label : `${label} (default)`;
}
