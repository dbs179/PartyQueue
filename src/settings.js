// Small JSON-backed settings store for host preferences that should survive
// restarts (e.g. the never-ending-queue toggle). Lives in data/ alongside the
// Spotify token store, so it's gitignored and persisted by the Docker volume.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import {
  bannerExists,
  migrateBannerFilenames,
} from "./banners.js";
import {
  djIconExists,
  migrateDjIconFilenames,
  migrateLegacyIcons,
  seedStarterDjIcons,
} from "./dj-icon.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE =
  process.env.PARTYQUEUE_SETTINGS_FILE ||
  path.join(__dirname, "..", "data", "settings.json");

// In-memory cache: Random / Never-Ending / discovery tick loadSettings() often;
// avoid a sync disk read on every call.
let settingsCache = null;

export function loadSettings() {
  if (settingsCache) return settingsCache;
  try {
    settingsCache = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    settingsCache = {};
  }
  return settingsCache;
}

export function saveSettings(settings) {
  const next = settings && typeof settings === "object" ? settings : {};
  try {
    writeFileAtomic(SETTINGS_FILE, JSON.stringify(next, null, 2));
  } catch (err) {
    console.error("[settings] save failed:", err.message);
    // Fail closed: do not keep an in-memory value that never hit disk.
    throw err;
  }
  settingsCache = next;
}

/** Drop the cache (e.g. after an external edit). Next loadSettings() re-reads disk. */
export function bustSettingsCache() {
  settingsCache = null;
}

// Randomness knobs for the random / Never-Ending Queue picker. Defaults match
// the Android app; each is a positive integer the host can tune from the UI.
//   songMemory         - how many newest history entries Random won't replay
//                        (history itself keeps up to HISTORY_CAP = 1500)
//   artistWindow       - how many recent songs the per-artist budget looks back over
//   artistCap          - max plays of any one artist within that window
//   endlessQueueCount  - songs Never-Ending Queue adds on each refill
//   strictFill         - when true, never drop song memory just to fill a short batch
  //   sameArtistBatchEnabled / sameArtistBatchEveryN — Booth: automatic same-artist
  //     showcase every N Random/Never-Ending sets (overrides unique-artist harden).
export const RANDOMNESS_DEFAULTS = {
  songMemory: 500,
  artistWindow: 30,
  artistCap: 1,
  endlessQueueCount: 5,
  strictFill: true,
  sameArtistBatchEnabled: false,
  sameArtistBatchEveryN: 8,
};

// Generous sanity bounds so a typo can't wedge the picker (e.g. a 10-million
// song memory or a zero cap).
const RANDOMNESS_BOUNDS = {
  songMemory: { min: 1, max: 10000 },
  artistWindow: { min: 1, max: 1000 },
  artistCap: { min: 1, max: 100 },
  endlessQueueCount: { min: 1, max: 100 },
  sameArtistBatchEveryN: { min: 1, max: 100 },
};

const RANDOMNESS_INT_KEYS = [
  "songMemory",
  "artistWindow",
  "artistCap",
  "endlessQueueCount",
  "sameArtistBatchEveryN",
];

function clampInt(value, fallback, { min, max }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// Current randomness settings, merged over defaults and bounds-checked.
export function getRandomnessSettings() {
  const s = loadSettings();
  const out = {};
  for (const key of RANDOMNESS_INT_KEYS) {
    out[key] = clampInt(s[key], RANDOMNESS_DEFAULTS[key], RANDOMNESS_BOUNDS[key]);
  }
  out.strictFill =
    typeof s.strictFill === "boolean" ? s.strictFill : RANDOMNESS_DEFAULTS.strictFill;
  out.sameArtistBatchEnabled =
    typeof s.sameArtistBatchEnabled === "boolean"
      ? s.sameArtistBatchEnabled
      : RANDOMNESS_DEFAULTS.sameArtistBatchEnabled;
  return out;
}

// Automatic rotation between Never-Ending sets ("Random Mood" / "Random
// Decade"). `...Pool` holds the ids eligible for rotation: mood-preset ids
// ("party", "chill", ...) and decade ids ("60s".."2020s"). Pools are stored as
// sanitized id strings only — the rotation engine re-validates against the
// live preset/decade registries at pick time (settings.js can't import
// moods.js: moods -> closing-time -> settings would be a cycle), so a stale
// id in the file is simply never picked.
export const ROTATION_DEFAULTS = {
  randomMoodEnabled: false,
  randomDecadeEnabled: false,
  randomMoodEverySets: 1,
  randomDecadeEverySets: 1,
  randomMoodPool: ["party", "chill", "country", "heavy", "rap"],
  randomDecadePool: ["60s", "70s", "80s", "90s", "2000s", "2010s", "2020s"],
};
const ROTATION_EVERY_BOUNDS = { min: 1, max: 20 };

/** Dedupe + lowercase an id array; non-arrays fall back to the default. */
function cleanIdArray(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const out = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const id = v.trim().toLowerCase().slice(0, 24);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export function getRotationSettings() {
  const s = loadSettings();
  return {
    randomMoodEnabled:
      typeof s.randomMoodEnabled === "boolean"
        ? s.randomMoodEnabled
        : ROTATION_DEFAULTS.randomMoodEnabled,
    randomDecadeEnabled:
      typeof s.randomDecadeEnabled === "boolean"
        ? s.randomDecadeEnabled
        : ROTATION_DEFAULTS.randomDecadeEnabled,
    randomMoodEverySets: clampInt(
      s.randomMoodEverySets,
      ROTATION_DEFAULTS.randomMoodEverySets,
      ROTATION_EVERY_BOUNDS
    ),
    randomDecadeEverySets: clampInt(
      s.randomDecadeEverySets,
      ROTATION_DEFAULTS.randomDecadeEverySets,
      ROTATION_EVERY_BOUNDS
    ),
    randomMoodPool: cleanIdArray(s.randomMoodPool, ROTATION_DEFAULTS.randomMoodPool),
    randomDecadePool: cleanIdArray(
      s.randomDecadePool,
      ROTATION_DEFAULTS.randomDecadePool
    ),
  };
}

// Persist a partial rotation update; returns the effective settings.
export function setRotationSettings(partial = {}) {
  const next = { ...loadSettings() };
  if (partial.randomMoodEnabled != null) {
    next.randomMoodEnabled = !!partial.randomMoodEnabled;
  }
  if (partial.randomDecadeEnabled != null) {
    next.randomDecadeEnabled = !!partial.randomDecadeEnabled;
  }
  if (partial.randomMoodEverySets != null) {
    next.randomMoodEverySets = clampInt(
      partial.randomMoodEverySets,
      ROTATION_DEFAULTS.randomMoodEverySets,
      ROTATION_EVERY_BOUNDS
    );
  }
  if (partial.randomDecadeEverySets != null) {
    next.randomDecadeEverySets = clampInt(
      partial.randomDecadeEverySets,
      ROTATION_DEFAULTS.randomDecadeEverySets,
      ROTATION_EVERY_BOUNDS
    );
  }
  if (Array.isArray(partial.randomMoodPool)) {
    next.randomMoodPool = cleanIdArray(
      partial.randomMoodPool,
      ROTATION_DEFAULTS.randomMoodPool
    );
  }
  if (Array.isArray(partial.randomDecadePool)) {
    next.randomDecadePool = cleanIdArray(
      partial.randomDecadePool,
      ROTATION_DEFAULTS.randomDecadePool
    );
  }
  saveSettings(next);
  return getRotationSettings();
}

// "Songs Like" discovery: whether to mix in Last.fm-similar songs from outside
// the host's playlists. Discovery slots are carved out of the requested count,
// while at least half of each batch remains selected-playlist music.
export const DISCOVERY_DEFAULTS = {
  discoverEnabled: true,
  similarCount: 2,
};
const DISCOVERY_DEFAULT_VERSION = 1;
const SIMILAR_BOUNDS = { min: 0, max: 50 };

export function getDiscoverySettings() {
  let s = loadSettings();
  // 7.1.x migration: older persisted settings may explicitly contain false,
  // which masks the newer on-by-default behavior. Enable it once on upgrade,
  // then preserve any host choice made after this migration.
  if ((Number(s.discoveryDefaultVersion) || 0) < DISCOVERY_DEFAULT_VERSION) {
    const migrated = {
      ...s,
      discoverEnabled: true,
      discoveryDefaultVersion: DISCOVERY_DEFAULT_VERSION,
    };
    try {
      saveSettings(migrated);
      s = migrated;
    } catch {
      // Keep reads usable if the data volume is temporarily unwritable.
      s = { ...s, discoverEnabled: true };
    }
  }
  return {
    discoverEnabled:
      typeof s.discoverEnabled === "boolean"
        ? s.discoverEnabled
        : DISCOVERY_DEFAULTS.discoverEnabled,
    similarCount: clampInt(
      s.similarCount,
      DISCOVERY_DEFAULTS.similarCount,
      SIMILAR_BOUNDS
    ),
  };
}

// Persist a partial discovery update; returns the effective settings.
export function setDiscoverySettings(partial = {}) {
  const next = { ...loadSettings() };
  if (partial.discoverEnabled != null) next.discoverEnabled = !!partial.discoverEnabled;
  if (partial.similarCount != null) {
    next.similarCount = clampInt(
      partial.similarCount,
      next.similarCount ?? DISCOVERY_DEFAULTS.similarCount,
      SIMILAR_BOUNDS
    );
  }
  saveSettings(next);
  return getDiscoverySettings();
}

// Optional guest-request fairness. Disabled by default so upgrades preserve the
// current unlimited behavior until the host explicitly enables it.
export const REQUEST_FAIRNESS_DEFAULTS = {
  requestFairnessEnabled: false,
  requestFairnessUpcomingThreshold: 5,
  requestFairnessUpcomingCap: 2,
  requestFairnessRollingMax: 5,
  requestFairnessWindowMinutes: 30,
  requestFairnessHostBypass: false,
};

const REQUEST_FAIRNESS_BOUNDS = {
  requestFairnessUpcomingThreshold: { min: 1, max: 100 },
  requestFairnessUpcomingCap: { min: 1, max: 20 },
  requestFairnessRollingMax: { min: 1, max: 100 },
  requestFairnessWindowMinutes: { min: 1, max: 1440 },
};

export function getRequestFairnessSettings() {
  const s = loadSettings();
  return {
    requestFairnessEnabled:
      typeof s.requestFairnessEnabled === "boolean"
        ? s.requestFairnessEnabled
        : REQUEST_FAIRNESS_DEFAULTS.requestFairnessEnabled,
    requestFairnessUpcomingThreshold: clampInt(
      s.requestFairnessUpcomingThreshold,
      REQUEST_FAIRNESS_DEFAULTS.requestFairnessUpcomingThreshold,
      REQUEST_FAIRNESS_BOUNDS.requestFairnessUpcomingThreshold
    ),
    requestFairnessUpcomingCap: clampInt(
      s.requestFairnessUpcomingCap,
      REQUEST_FAIRNESS_DEFAULTS.requestFairnessUpcomingCap,
      REQUEST_FAIRNESS_BOUNDS.requestFairnessUpcomingCap
    ),
    requestFairnessRollingMax: clampInt(
      s.requestFairnessRollingMax,
      REQUEST_FAIRNESS_DEFAULTS.requestFairnessRollingMax,
      REQUEST_FAIRNESS_BOUNDS.requestFairnessRollingMax
    ),
    requestFairnessWindowMinutes: clampInt(
      s.requestFairnessWindowMinutes,
      REQUEST_FAIRNESS_DEFAULTS.requestFairnessWindowMinutes,
      REQUEST_FAIRNESS_BOUNDS.requestFairnessWindowMinutes
    ),
    requestFairnessHostBypass:
      typeof s.requestFairnessHostBypass === "boolean"
        ? s.requestFairnessHostBypass
        : REQUEST_FAIRNESS_DEFAULTS.requestFairnessHostBypass,
  };
}

export function setRequestFairnessSettings(partial = {}) {
  const next = { ...loadSettings() };
  for (const key of Object.keys(REQUEST_FAIRNESS_BOUNDS)) {
    if (partial[key] != null) {
      next[key] = clampInt(
        partial[key],
        next[key] ?? REQUEST_FAIRNESS_DEFAULTS[key],
        REQUEST_FAIRNESS_BOUNDS[key]
      );
    }
  }
  if (partial.requestFairnessEnabled != null) {
    next.requestFairnessEnabled = !!partial.requestFairnessEnabled;
  }
  if (partial.requestFairnessHostBypass != null) {
    next.requestFairnessHostBypass = !!partial.requestFairnessHostBypass;
  }
  saveSettings(next);
  return getRequestFairnessSettings();
}

// DJ voice announcements (Home Assistant TTS between sets). Off by default.
// Persona fields (name / icon / intro % / max words) live here too; the
// enable toggle stays a Controls switch and is saved independently.
export const DJ_VOICE_DEFAULTS = {
  djVoiceEnabled: true,
  djName: "Party DJ",
  // Seeded starter from public/dj-icons/flat.png → data/dj-icons/.
  // Fresh installs use this; hosts can upload/rename freely.
  djIcon: "dj-icon-flat.png",
  djNameIntroPercent: 25,
  djAnnounceMaxWords: 55,
  // DJ announce volume: boost = % of remaining room up to 100, by music tier.
  // Tuned for louder ElevenLabs TTS (lower than the old OpenAI-era defaults).
  djVolumeBumpLowPct: 20,
  djVolumeBumpMidPct: 8,
  djVolumeBumpHighPct: 4,
  // Legacy one-pad duration, retained for settings compatibility.
  djSilenceSec: 2,
  // Pre/post handoff pads. New field intentionally defaults existing installs
  // to the safer 3-second stepped-ramp window.
  djHandoffSilenceSec: 3,
  // TTS via Home Assistant: ElevenLabs (expressive) or OpenAI.
  djTtsProvider: "elevenlabs_ha",
  djTtsVoiceOpenAi: "onyx",
  djTtsVoiceElevenlabs: "",
  // OpenAI TTS speaking rate (0.25–4.0; we expose useful party values).
  // Also applied locally via ffmpeg for ElevenLabs clips.
  djTtsSpeed: 1,
  // Phase 6: character intensity + optional catchphrase / ban-list.
  djCharacterIntensity: "extra",
  djCatchphrase: "",
  djBanList: "",
  // Host-only advanced prompt guidance. Core safety/shape rules remain in code.
  djPersonaNotes: "",
  djAlwaysInstructions: "",
  djNeverInstructions: "",
  // One literal mapping per line: Written name = TTS-friendly pronunciation.
  djPronunciations: "",
  // Mood Pulse / DJ shout-outs on searched adds.
  djShoutEnabled: true,
  djShoutMode: "every", // "percent" | "every"
  djShoutPercent: 25,
  djShoutEveryN: 5,
  // Last call: null URI = built-in Closing Time (Semisonic) match.
  endOfNightTrackUri: null,
  endOfNightTrackName: null,
  endOfNightTrackArtist: null,
  // Spoken party recap TTS before the end-of-night song (needs DJ Voice).
  djPartyRecapEnabled: true,
};

export const DEFAULT_END_OF_NIGHT = {
  name: "Closing Time",
  artist: "Semisonic",
};

const END_OF_NIGHT_NAME_MAX = 200;
const END_OF_NIGHT_ARTIST_MAX = 200;

export function cleanEndOfNightUri(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;
  let decoded = t;
  try {
    decoded = decodeURIComponent(t);
  } catch {
    /* keep t */
  }
  const m = decoded.match(/spotify:track:([A-Za-z0-9]+)/i);
  return m ? `spotify:track:${m[1]}` : null;
}

function cleanEndOfNightText(value, max) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return null;
  const t = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
  return t || null;
}

export const DJ_SHOUT_MODE_OPTIONS = ["percent", "every"];
export const DJ_SHOUT_PERCENT_BOUNDS = { min: 0, max: 100 };
export const DJ_SHOUT_EVERY_BOUNDS = { min: 1, max: 50 };

function normalizeDjShoutMode(value, fallback = DJ_VOICE_DEFAULTS.djShoutMode) {
  const v = String(value || "").trim().toLowerCase();
  return DJ_SHOUT_MODE_OPTIONS.includes(v) ? v : fallback;
}

export const DJ_CHARACTER_INTENSITY_OPTIONS = [
  { id: "subtle", label: "Subtle — quieter personality, fewer asides" },
  { id: "classic", label: "Classic — balanced host personality" },
  { id: "extra", label: "Extra — bigger personality, more bits" },
];

const DJ_CHARACTER_INTENSITY_IDS = new Set(
  DJ_CHARACTER_INTENSITY_OPTIONS.map((o) => o.id)
);
const DJ_CATCHPHRASE_MAXLEN = 80;
const DJ_BAN_LIST_MAXLEN = 240;
const DJ_ADVANCED_INSTRUCTIONS_MAXLEN = 800;
const DJ_PRONUNCIATIONS_MAXLEN = 2400;
const DJ_PRONUNCIATIONS_MAX_ENTRIES = 40;

// Allowed silence-bridge lengths; each has a bundled dj-silence-Ns.mp3.
export const DJ_SILENCE_OPTIONS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

export const DJ_TTS_PROVIDERS = [
  {
    id: "elevenlabs_ha",
    label: "ElevenLabs (Home Assistant)",
    engine: "tts.elevenlabs_text_to_speech",
  },
  {
    id: "openai_ha",
    label: "OpenAI (Home Assistant)",
    engine: "tts.openai_tts_2",
  },
];

const DJ_TTS_PROVIDER_IDS = new Set(DJ_TTS_PROVIDERS.map((p) => p.id));

export function normalizeDjTtsProvider(
  value,
  fallback = DJ_VOICE_DEFAULTS.djTtsProvider
) {
  const id = String(value || "")
    .trim()
    .toLowerCase();
  if (DJ_TTS_PROVIDER_IDS.has(id)) return id;
  return fallback;
}

export function djTtsEngineForProvider(provider) {
  const p = normalizeDjTtsProvider(provider);
  const row = DJ_TTS_PROVIDERS.find((x) => x.id === p);
  return row?.engine || DJ_TTS_PROVIDERS[0].engine;
}

// OpenAI TTS voices commonly supported by HA's OpenAI TTS engines (tts-1 class).
export const DJ_TTS_VOICES = [
  { id: "onyx", label: "Onyx — deep, authoritative" },
  { id: "alloy", label: "Alloy — neutral, balanced" },
  { id: "ash", label: "Ash — clear, articulate" },
  { id: "coral", label: "Coral — warm, friendly" },
  { id: "echo", label: "Echo — resonant, clear" },
  { id: "fable", label: "Fable — expressive, storyteller" },
  { id: "nova", label: "Nova — energetic, bright" },
  { id: "sage", label: "Sage — calm, measured" },
  { id: "shimmer", label: "Shimmer — light, cheerful" },
];

// Practical speaking rates for DJ announcements (OpenAI allows 0.25–4.0).
export const DJ_TTS_SPEED_OPTIONS = [0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.25];

const DJ_TTS_VOICE_IDS = new Set(DJ_TTS_VOICES.map((v) => v.id));

/** Normalize an OpenAI TTS voice name. */
export function normalizeDjTtsVoiceOpenAi(
  value,
  fallback = DJ_VOICE_DEFAULTS.djTtsVoiceOpenAi
) {
  const id = String(value || "")
    .trim()
    .toLowerCase();
  if (DJ_TTS_VOICE_IDS.has(id)) return id;
  return fallback;
}

/** Normalize an ElevenLabs voice ID (preserve case). */
export function normalizeDjTtsVoiceElevenlabs(
  value,
  fallback = DJ_VOICE_DEFAULTS.djTtsVoiceElevenlabs
) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9]{10,64}$/.test(raw)) return raw;
  return fallback;
}

/**
 * Active voice for a TTS provider.
 * @param {string} value
 * @param {string} [provider]
 * @param {string} [fallback]
 */
export function normalizeDjTtsVoice(
  value,
  provider = DJ_VOICE_DEFAULTS.djTtsProvider,
  fallback = undefined
) {
  const p = normalizeDjTtsProvider(provider);
  if (p === "openai_ha") {
    return normalizeDjTtsVoiceOpenAi(
      value,
      fallback ?? DJ_VOICE_DEFAULTS.djTtsVoiceOpenAi
    );
  }
  return normalizeDjTtsVoiceElevenlabs(
    value,
    fallback ?? DJ_VOICE_DEFAULTS.djTtsVoiceElevenlabs
  );
}

export function normalizeDjTtsSpeed(
  value,
  fallback = DJ_VOICE_DEFAULTS.djTtsSpeed
) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  // Clamp to OpenAI's allowed range, then snap to a offered step.
  const clamped = Math.max(0.25, Math.min(4, n));
  if (DJ_TTS_SPEED_OPTIONS.includes(clamped)) return clamped;
  let best = fallback;
  let bestDist = Infinity;
  for (const opt of DJ_TTS_SPEED_OPTIONS) {
    const d = Math.abs(opt - clamped);
    if (d < bestDist) {
      bestDist = d;
      best = opt;
    }
  }
  return best;
}

/** Public fallback art when the seeded gallery default is missing. */
export const DJ_ICON_DEFAULT_URL = "/dj-icons/flat.png";
const DJ_NAME_MAXLEN = 40;
const DJ_NAME_INTRO_BOUNDS = { min: 0, max: 100 };
const DJ_ANNOUNCE_WORDS_BOUNDS = { min: 28, max: 120 };
const DJ_VOLUME_BUMP_PCT_BOUNDS = { min: 0, max: 100 };
/** Music volume tiers for percent-based DJ boost (Sonos 0–100). */
export const DJ_VOLUME_TIER = { lowMax: 30, midMax: 60 };

export function normalizeDjSilenceSec(
  value,
  fallback = DJ_VOICE_DEFAULTS.djSilenceSec
) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (DJ_SILENCE_OPTIONS.includes(n)) return n;
  // Snap to nearest allowed option (handles 1.0 → 1, typos, etc.).
  let best = fallback;
  let bestDist = Infinity;
  for (const opt of DJ_SILENCE_OPTIONS) {
    const d = Math.abs(opt - n);
    if (d < bestDist) {
      bestDist = d;
      best = opt;
    }
  }
  return best;
}

export function djSilenceLabel(sec) {
  const n = normalizeDjSilenceSec(sec);
  return Number.isInteger(n) ? String(n) : String(n);
}

export function normalizeDjCharacterIntensity(
  value,
  fallback = DJ_VOICE_DEFAULTS.djCharacterIntensity
) {
  const id = String(value || "")
    .trim()
    .toLowerCase();
  if (DJ_CHARACTER_INTENSITY_IDS.has(id)) return id;
  return fallback;
}

export function normalizeDjCatchphrase(
  value,
  fallback = DJ_VOICE_DEFAULTS.djCatchphrase
) {
  if (value == null) return fallback;
  if (typeof value !== "string") return fallback;
  return value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, DJ_CATCHPHRASE_MAXLEN);
}

// Comma- or newline-separated phrases the DJ should not say.
export function normalizeDjBanList(
  value,
  fallback = DJ_VOICE_DEFAULTS.djBanList
) {
  if (value == null) return fallback;
  if (typeof value !== "string") return fallback;
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, DJ_BAN_LIST_MAXLEN);
  return cleaned;
}

export function parseDjBanList(value) {
  const raw = normalizeDjBanList(value, "");
  if (!raw) return [];
  return raw
    .split(/[\n,]+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2);
}

function normalizeDjAdvancedText(value, fallback, maxLength) {
  if (value == null) return fallback;
  if (typeof value !== "string") return fallback;
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLength);
}

export function normalizeDjPersonaNotes(
  value,
  fallback = DJ_VOICE_DEFAULTS.djPersonaNotes
) {
  return normalizeDjAdvancedText(
    value,
    fallback,
    DJ_ADVANCED_INSTRUCTIONS_MAXLEN
  );
}

export function normalizeDjAlwaysInstructions(
  value,
  fallback = DJ_VOICE_DEFAULTS.djAlwaysInstructions
) {
  return normalizeDjAdvancedText(
    value,
    fallback,
    DJ_ADVANCED_INSTRUCTIONS_MAXLEN
  );
}

export function normalizeDjNeverInstructions(
  value,
  fallback = DJ_VOICE_DEFAULTS.djNeverInstructions
) {
  return normalizeDjAdvancedText(
    value,
    fallback,
    DJ_ADVANCED_INSTRUCTIONS_MAXLEN
  );
}

export function normalizeDjPronunciations(
  value,
  fallback = DJ_VOICE_DEFAULTS.djPronunciations
) {
  return normalizeDjAdvancedText(value, fallback, DJ_PRONUNCIATIONS_MAXLEN);
}

export function parseDjPronunciations(value) {
  const raw = normalizeDjPronunciations(value, "");
  if (!raw) return [];
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(.{1,120}?)\s*(?:=>|=)\s*(.{1,160})$/);
    if (!match) continue;
    const written = match[1].trim();
    const spoken = match[2].trim();
    if (written.length < 2 || !spoken || written === spoken) continue;
    entries.push({ written, spoken });
    if (entries.length >= DJ_PRONUNCIATIONS_MAX_ENTRIES) break;
  }
  return entries.sort((a, b) => b.written.length - a.written.length);
}

function cleanDjName(value) {
  if (typeof value !== "string") return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, DJ_NAME_MAXLEN);
}

function cleanDjIcon(value) {
  if (value === null || value === "" || value === "default") return null;
  if (typeof value !== "string") return null;
  // Gallery filenames (and a one-time legacy single-file name).
  if (
    !/^dj-icon-(?:\d+-)?[a-z][a-z0-9]*\.(png|jpg|webp|svg|gif)$/i.test(value) &&
    !/^dj-icon\.(png|jpg|webp|svg|gif)$/i.test(value)
  ) {
    return null;
  }
  return value;
}

export function djIconUrl(iconName) {
  const name = cleanDjIcon(iconName);
  return name ? `/dj-icon/${name}` : DJ_ICON_DEFAULT_URL;
}

export function getDjVoiceSettings() {
  const s = loadSettings();
  const name = cleanDjName(s.djName);
  // One-time move / rename of older icon filenames into the short gallery names.
  seedStarterDjIcons();
  const migrated = new Map([
    ...migrateLegacyIcons(),
    ...migrateDjIconFilenames(),
  ]);
  let iconRaw = cleanDjIcon(s.djIcon);
  if (iconRaw && migrated.has(iconRaw)) {
    iconRaw = migrated.get(iconRaw);
    const next = { ...s, djIcon: iconRaw };
    try {
      saveSettings(next);
    } catch {
      /* migration is best-effort; don't break Settings reads */
    }
  }
  // Missing / cleared icon → app default (flat starter); else require file on disk.
  if (!iconRaw) iconRaw = cleanDjIcon(DJ_VOICE_DEFAULTS.djIcon);
  const icon = iconRaw && djIconExists(iconRaw) ? iconRaw : null;

  let djTtsProvider;
  if (s.djTtsProvider != null) {
    djTtsProvider = normalizeDjTtsProvider(s.djTtsProvider);
  } else {
    const legacy = String(s.djTtsVoice || "").trim();
    djTtsProvider =
      legacy && DJ_TTS_VOICE_IDS.has(legacy.toLowerCase())
        ? "openai_ha"
        : DJ_VOICE_DEFAULTS.djTtsProvider;
  }

  const legacyVoice = String(s.djTtsVoice || "").trim();
  const djTtsVoiceOpenAi = normalizeDjTtsVoiceOpenAi(
    s.djTtsVoiceOpenAi ??
      (DJ_TTS_VOICE_IDS.has(legacyVoice.toLowerCase()) ? legacyVoice : null),
    DJ_VOICE_DEFAULTS.djTtsVoiceOpenAi
  );
  const djTtsVoiceElevenlabs = normalizeDjTtsVoiceElevenlabs(
    s.djTtsVoiceElevenlabs ??
      (legacyVoice && !DJ_TTS_VOICE_IDS.has(legacyVoice.toLowerCase())
        ? legacyVoice
        : null),
    DJ_VOICE_DEFAULTS.djTtsVoiceElevenlabs
  );
  const djTtsVoice =
    djTtsProvider === "openai_ha" ? djTtsVoiceOpenAi : djTtsVoiceElevenlabs;

  return {
    djVoiceEnabled:
      typeof s.djVoiceEnabled === "boolean"
        ? s.djVoiceEnabled
        : DJ_VOICE_DEFAULTS.djVoiceEnabled,
    djName: name || DJ_VOICE_DEFAULTS.djName,
    djIcon: icon,
    djIconUrl: djIconUrl(icon),
    djNameIntroPercent: clampInt(
      s.djNameIntroPercent,
      DJ_VOICE_DEFAULTS.djNameIntroPercent,
      DJ_NAME_INTRO_BOUNDS
    ),
    djAnnounceMaxWords: clampInt(
      s.djAnnounceMaxWords,
      DJ_VOICE_DEFAULTS.djAnnounceMaxWords,
      DJ_ANNOUNCE_WORDS_BOUNDS
    ),
    djVolumeBumpLowPct: clampInt(
      s.djVolumeBumpLowPct,
      DJ_VOICE_DEFAULTS.djVolumeBumpLowPct,
      DJ_VOLUME_BUMP_PCT_BOUNDS
    ),
    djVolumeBumpMidPct: clampInt(
      s.djVolumeBumpMidPct,
      DJ_VOICE_DEFAULTS.djVolumeBumpMidPct,
      DJ_VOLUME_BUMP_PCT_BOUNDS
    ),
    djVolumeBumpHighPct: clampInt(
      s.djVolumeBumpHighPct,
      DJ_VOICE_DEFAULTS.djVolumeBumpHighPct,
      DJ_VOLUME_BUMP_PCT_BOUNDS
    ),
    djSilenceSec: normalizeDjSilenceSec(
      s.djSilenceSec,
      DJ_VOICE_DEFAULTS.djSilenceSec
    ),
    djHandoffSilenceSec: DJ_VOICE_DEFAULTS.djHandoffSilenceSec,
    djTtsProvider,
    djTtsEngine: djTtsEngineForProvider(djTtsProvider),
    djTtsVoiceOpenAi,
    djTtsVoiceElevenlabs,
    djTtsVoice,
    djTtsSpeed: normalizeDjTtsSpeed(
      s.djTtsSpeed,
      DJ_VOICE_DEFAULTS.djTtsSpeed
    ),
    djCharacterIntensity: normalizeDjCharacterIntensity(
      s.djCharacterIntensity,
      DJ_VOICE_DEFAULTS.djCharacterIntensity
    ),
    djCatchphrase: normalizeDjCatchphrase(
      s.djCatchphrase,
      DJ_VOICE_DEFAULTS.djCatchphrase
    ),
    djBanList: normalizeDjBanList(
      s.djBanList,
      DJ_VOICE_DEFAULTS.djBanList
    ),
    djPersonaNotes: normalizeDjPersonaNotes(
      s.djPersonaNotes,
      DJ_VOICE_DEFAULTS.djPersonaNotes
    ),
    djAlwaysInstructions: normalizeDjAlwaysInstructions(
      s.djAlwaysInstructions,
      DJ_VOICE_DEFAULTS.djAlwaysInstructions
    ),
    djNeverInstructions: normalizeDjNeverInstructions(
      s.djNeverInstructions,
      DJ_VOICE_DEFAULTS.djNeverInstructions
    ),
    djPronunciations: normalizeDjPronunciations(
      s.djPronunciations,
      DJ_VOICE_DEFAULTS.djPronunciations
    ),
    djShoutEnabled:
      typeof s.djShoutEnabled === "boolean"
        ? s.djShoutEnabled
        : DJ_VOICE_DEFAULTS.djShoutEnabled,
    djShoutMode: normalizeDjShoutMode(
      s.djShoutMode,
      DJ_VOICE_DEFAULTS.djShoutMode
    ),
    djShoutPercent: clampInt(
      s.djShoutPercent,
      DJ_VOICE_DEFAULTS.djShoutPercent,
      DJ_SHOUT_PERCENT_BOUNDS
    ),
    djShoutEveryN: clampInt(
      s.djShoutEveryN,
      DJ_VOICE_DEFAULTS.djShoutEveryN,
      DJ_SHOUT_EVERY_BOUNDS
    ),
    endOfNightTrackUri: cleanEndOfNightUri(s.endOfNightTrackUri),
    endOfNightTrackName: cleanEndOfNightText(
      s.endOfNightTrackName,
      END_OF_NIGHT_NAME_MAX
    ),
    endOfNightTrackArtist: cleanEndOfNightText(
      s.endOfNightTrackArtist,
      END_OF_NIGHT_ARTIST_MAX
    ),
    djPartyRecapEnabled:
      typeof s.djPartyRecapEnabled === "boolean"
        ? s.djPartyRecapEnabled
        : DJ_VOICE_DEFAULTS.djPartyRecapEnabled,
  };
}

export function setDjVoiceSettings(partial = {}) {
  const next = { ...loadSettings() };
  if (partial.djVoiceEnabled != null) next.djVoiceEnabled = !!partial.djVoiceEnabled;
  if (partial.djName != null) {
    next.djName = cleanDjName(partial.djName) || DJ_VOICE_DEFAULTS.djName;
  }
  if (partial.djIcon !== undefined) {
    next.djIcon = cleanDjIcon(partial.djIcon);
  }
  if (partial.djNameIntroPercent != null) {
    next.djNameIntroPercent = clampInt(
      partial.djNameIntroPercent,
      next.djNameIntroPercent ?? DJ_VOICE_DEFAULTS.djNameIntroPercent,
      DJ_NAME_INTRO_BOUNDS
    );
  }
  if (partial.djAnnounceMaxWords != null) {
    next.djAnnounceMaxWords = clampInt(
      partial.djAnnounceMaxWords,
      next.djAnnounceMaxWords ?? DJ_VOICE_DEFAULTS.djAnnounceMaxWords,
      DJ_ANNOUNCE_WORDS_BOUNDS
    );
  }
  if (partial.djVolumeBumpLowPct != null) {
    next.djVolumeBumpLowPct = clampInt(
      partial.djVolumeBumpLowPct,
      next.djVolumeBumpLowPct ?? DJ_VOICE_DEFAULTS.djVolumeBumpLowPct,
      DJ_VOLUME_BUMP_PCT_BOUNDS
    );
  }
  if (partial.djVolumeBumpMidPct != null) {
    next.djVolumeBumpMidPct = clampInt(
      partial.djVolumeBumpMidPct,
      next.djVolumeBumpMidPct ?? DJ_VOICE_DEFAULTS.djVolumeBumpMidPct,
      DJ_VOLUME_BUMP_PCT_BOUNDS
    );
  }
  if (partial.djVolumeBumpHighPct != null) {
    next.djVolumeBumpHighPct = clampInt(
      partial.djVolumeBumpHighPct,
      next.djVolumeBumpHighPct ?? DJ_VOICE_DEFAULTS.djVolumeBumpHighPct,
      DJ_VOLUME_BUMP_PCT_BOUNDS
    );
  }
  if (partial.djSilenceSec != null) {
    next.djSilenceSec = normalizeDjSilenceSec(
      partial.djSilenceSec,
      next.djSilenceSec ?? DJ_VOICE_DEFAULTS.djSilenceSec
    );
  }
  if (partial.djHandoffSilenceSec != null) {
    next.djHandoffSilenceSec = DJ_VOICE_DEFAULTS.djHandoffSilenceSec;
  }
  if (partial.djTtsProvider != null) {
    next.djTtsProvider = normalizeDjTtsProvider(partial.djTtsProvider);
  }
  const providerForVoice = normalizeDjTtsProvider(
    partial.djTtsProvider ?? next.djTtsProvider ?? DJ_VOICE_DEFAULTS.djTtsProvider
  );
  if (partial.djTtsVoiceOpenAi != null) {
    next.djTtsVoiceOpenAi = normalizeDjTtsVoiceOpenAi(partial.djTtsVoiceOpenAi);
  }
  if (partial.djTtsVoiceElevenlabs != null) {
    next.djTtsVoiceElevenlabs = normalizeDjTtsVoiceElevenlabs(
      partial.djTtsVoiceElevenlabs
    );
  }
  // Convenience: djTtsVoice writes into the active provider's field.
  if (partial.djTtsVoice != null) {
    if (providerForVoice === "openai_ha") {
      next.djTtsVoiceOpenAi = normalizeDjTtsVoiceOpenAi(partial.djTtsVoice);
    } else {
      next.djTtsVoiceElevenlabs = normalizeDjTtsVoiceElevenlabs(
        partial.djTtsVoice
      );
    }
    // Clear legacy single-field so migration doesn't fight new values.
    delete next.djTtsVoice;
  }
  if (partial.djTtsSpeed != null) {
    next.djTtsSpeed = normalizeDjTtsSpeed(
      partial.djTtsSpeed,
      next.djTtsSpeed ?? DJ_VOICE_DEFAULTS.djTtsSpeed
    );
  }
  if (partial.djCharacterIntensity != null) {
    next.djCharacterIntensity = normalizeDjCharacterIntensity(
      partial.djCharacterIntensity,
      next.djCharacterIntensity ?? DJ_VOICE_DEFAULTS.djCharacterIntensity
    );
  }
  if (partial.djCatchphrase != null) {
    next.djCatchphrase = normalizeDjCatchphrase(partial.djCatchphrase, "");
  }
  if (partial.djBanList != null) {
    next.djBanList = normalizeDjBanList(partial.djBanList, "");
  }
  if (partial.djPersonaNotes != null) {
    next.djPersonaNotes = normalizeDjPersonaNotes(partial.djPersonaNotes, "");
  }
  if (partial.djAlwaysInstructions != null) {
    next.djAlwaysInstructions = normalizeDjAlwaysInstructions(
      partial.djAlwaysInstructions,
      ""
    );
  }
  if (partial.djNeverInstructions != null) {
    next.djNeverInstructions = normalizeDjNeverInstructions(
      partial.djNeverInstructions,
      ""
    );
  }
  if (partial.djPronunciations != null) {
    next.djPronunciations = normalizeDjPronunciations(
      partial.djPronunciations,
      ""
    );
  }
  if (partial.djShoutEnabled != null) {
    next.djShoutEnabled = !!partial.djShoutEnabled;
  }
  if (partial.djShoutMode != null) {
    next.djShoutMode = normalizeDjShoutMode(
      partial.djShoutMode,
      next.djShoutMode ?? DJ_VOICE_DEFAULTS.djShoutMode
    );
  }
  if (partial.djShoutPercent != null) {
    next.djShoutPercent = clampInt(
      partial.djShoutPercent,
      next.djShoutPercent ?? DJ_VOICE_DEFAULTS.djShoutPercent,
      DJ_SHOUT_PERCENT_BOUNDS
    );
  }
  if (partial.djShoutEveryN != null) {
    next.djShoutEveryN = clampInt(
      partial.djShoutEveryN,
      next.djShoutEveryN ?? DJ_VOICE_DEFAULTS.djShoutEveryN,
      DJ_SHOUT_EVERY_BOUNDS
    );
  }
  if (partial.endOfNightTrackUri !== undefined) {
    next.endOfNightTrackUri = cleanEndOfNightUri(partial.endOfNightTrackUri);
    if (!next.endOfNightTrackUri) {
      // Reset to built-in Closing Time default.
      next.endOfNightTrackUri = null;
      next.endOfNightTrackName = null;
      next.endOfNightTrackArtist = null;
    }
  }
  if (partial.endOfNightTrackName !== undefined) {
    next.endOfNightTrackName = cleanEndOfNightText(
      partial.endOfNightTrackName,
      END_OF_NIGHT_NAME_MAX
    );
  }
  if (partial.endOfNightTrackArtist !== undefined) {
    next.endOfNightTrackArtist = cleanEndOfNightText(
      partial.endOfNightTrackArtist,
      END_OF_NIGHT_ARTIST_MAX
    );
  }
  // Clearing URI also clears name/artist when explicitly reset together.
  if (
    partial.endOfNightTrackUri === null ||
    partial.endOfNightTrackUri === ""
  ) {
    next.endOfNightTrackUri = null;
    if (partial.endOfNightTrackName === undefined) {
      next.endOfNightTrackName = null;
    }
    if (partial.endOfNightTrackArtist === undefined) {
      next.endOfNightTrackArtist = null;
    }
  }
  if (partial.djPartyRecapEnabled != null) {
    next.djPartyRecapEnabled = !!partial.djPartyRecapEnabled;
  }
  saveSettings(next);
  return getDjVoiceSettings();
}

// Content filtering + party rituals. `filterExplicit` hides explicit tracks from
// search / Random / Never-Ending / Discover. `requestsPaused` blocks guest Adds.
// `kidsLock` pins Kids mood + subtle DJ (snapshot restored on unlock).
export const CONTENT_DEFAULTS = {
  filterExplicit: false,
  requestsPaused: false,
  partyOver: false,
  hostControlsOnly: false,
  kidsLock: false,
};

// "Party's Over" auto-expires so a forgotten toggle can't lock out the next
// event (Saturday night's lockdown clears before Sunday's session).
export const PARTY_OVER_TTL_MS = 8 * 60 * 60 * 1000;

/** Never-Ending Queue on/off when settings.json has no value yet. */
export const NEVER_ENDING_DEFAULT = true;

export function getContentSettings() {
  const s = loadSettings();
  return {
    filterExplicit:
      typeof s.filterExplicit === "boolean"
        ? s.filterExplicit
        : CONTENT_DEFAULTS.filterExplicit,
    requestsPaused:
      typeof s.requestsPaused === "boolean"
        ? s.requestsPaused
        : CONTENT_DEFAULTS.requestsPaused,
    partyOver:
      typeof s.partyOver === "boolean" ? s.partyOver : CONTENT_DEFAULTS.partyOver,
    partyOverAt: Number(s.partyOverAt) || 0,
    hostControlsOnly:
      typeof s.hostControlsOnly === "boolean"
        ? s.hostControlsOnly
        : CONTENT_DEFAULTS.hostControlsOnly,
    kidsLock:
      typeof s.kidsLock === "boolean" ? s.kidsLock : CONTENT_DEFAULTS.kidsLock,
    kidsLockSnapshot:
      s.kidsLockSnapshot && typeof s.kidsLockSnapshot === "object"
        ? s.kidsLockSnapshot
        : null,
  };
}

// Persist a partial content update; returns the effective settings. Leaves other
// settings in the file untouched.
export function setContentSettings(partial = {}) {
  const next = { ...loadSettings() };
  if (partial.filterExplicit != null) next.filterExplicit = !!partial.filterExplicit;
  if (partial.requestsPaused != null) next.requestsPaused = !!partial.requestsPaused;
  if (partial.partyOver != null) {
    const on = !!partial.partyOver;
    next.partyOver = on;
    next.partyOverAt = on ? Date.now() : 0;
  }
  if (partial.hostControlsOnly != null) {
    next.hostControlsOnly = !!partial.hostControlsOnly;
  }
  if (partial.kidsLock != null) next.kidsLock = !!partial.kidsLock;
  if (partial.kidsLockSnapshot !== undefined) {
    next.kidsLockSnapshot = partial.kidsLockSnapshot;
  }
  saveSettings(next);
  return getContentSettings();
}

// Event branding: the header title and tagline, so the app can be reused for
// other events without editing code. `eventName` falls back to the default if
// blank (a header needs a title); `subtitle` may be empty to hide the tagline.
export const BRANDING_DEFAULTS = {
  eventName: "PartyQueue",
  subtitle: "",
  showVersion: false,
  // Up Next pills: matched genre + From Playlists next to origin badge.
  showQueueGenre: false,
  heroBanner: null, // null = built-in public/hero.jpg; otherwise a data/banners file
};
const BRANDING_MAXLEN = { eventName: 60, subtitle: 120 };

function cleanText(value, max) {
  if (typeof value !== "string") return null;
  // Strip control chars (incl. newlines) so the header stays single-line.
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

export function getBrandingSettings() {
  const s = loadSettings();
  const name = cleanText(s.eventName, BRANDING_MAXLEN.eventName);
  const sub = cleanText(s.subtitle, BRANDING_MAXLEN.subtitle);
  const renamed = migrateBannerFilenames();
  let heroBanner = typeof s.heroBanner === "string" ? s.heroBanner : null;
  if (heroBanner && renamed.has(heroBanner)) {
    heroBanner = renamed.get(heroBanner);
    try {
      saveSettings({ ...s, heroBanner });
    } catch {
      /* migration is best-effort */
    }
  }
  if (heroBanner && !bannerExists(heroBanner)) heroBanner = null;
  return {
    eventName: name || BRANDING_DEFAULTS.eventName,
    subtitle: sub == null ? BRANDING_DEFAULTS.subtitle : sub,
    showVersion:
      typeof s.showVersion === "boolean"
        ? s.showVersion
        : BRANDING_DEFAULTS.showVersion,
    showQueueGenre:
      typeof s.showQueueGenre === "boolean"
        ? s.showQueueGenre
        : BRANDING_DEFAULTS.showQueueGenre,
    heroBanner,
  };
}

// Persist a partial branding update; returns the effective settings. Leaves
// other settings in the file untouched.
export function setBrandingSettings(partial = {}) {
  const next = { ...loadSettings() };
  if (partial.eventName != null) {
    next.eventName = cleanText(partial.eventName, BRANDING_MAXLEN.eventName) || BRANDING_DEFAULTS.eventName;
  }
  if (partial.subtitle != null) {
    next.subtitle = cleanText(partial.subtitle, BRANDING_MAXLEN.subtitle) ?? "";
  }
  if (partial.showVersion != null) next.showVersion = !!partial.showVersion;
  if (partial.showQueueGenre != null) {
    next.showQueueGenre = !!partial.showQueueGenre;
  }
  if (partial.heroBanner !== undefined) {
    next.heroBanner =
      typeof partial.heroBanner === "string" && partial.heroBanner ? partial.heroBanner : null;
  }
  saveSettings(next);
  return getBrandingSettings();
}

// Which Sonos group PartyQueue controls. Persisted so the host can target a
// subgroup (e.g. Kitchen + Dining) at runtime without editing SONOS_ROOM in
// .env. Stores the coordinator room name; resolveGroup matches it against live
// topology. Falls back to SONOS_ROOM when unset.
function cleanRoomName(value) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t.slice(0, 80) : null;
}

export function getSonosTargetRoom() {
  const fromSettings = cleanRoomName(loadSettings().sonosTargetRoom);
  if (fromSettings) return fromSettings;
  return cleanRoomName(process.env.SONOS_ROOM) || null;
}

export function setSonosTargetRoom(room) {
  const next = { ...loadSettings() };
  const cleaned = cleanRoomName(room);
  if (cleaned) next.sonosTargetRoom = cleaned;
  else delete next.sonosTargetRoom;
  saveSettings(next);
  return getSonosTargetRoom();
}

// Persist a partial update (only the recognized keys), returning the effective
// settings after clamping. Other settings in the file are left untouched.
export function setRandomnessSettings(partial = {}) {
  const current = loadSettings();
  const next = { ...current };
  for (const key of RANDOMNESS_INT_KEYS) {
    if (partial[key] != null) {
      next[key] = clampInt(
        partial[key],
        current[key] ?? RANDOMNESS_DEFAULTS[key],
        RANDOMNESS_BOUNDS[key]
      );
    }
  }
  if (partial.strictFill != null) next.strictFill = !!partial.strictFill;
  if (partial.sameArtistBatchEnabled != null) {
    next.sameArtistBatchEnabled = !!partial.sameArtistBatchEnabled;
  }
  saveSettings(next);
  return getRandomnessSettings();
}
