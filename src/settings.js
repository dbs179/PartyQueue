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
import {
  normalizeSonosPlayerType,
  lookupSonosPlayerType,
} from "./sonos-player-types.js";
import { DJ_TAGLINES, normalizeDjTaglines } from "./dj-taglines.js";
import {
  SISTER_STATIC_PERSONA_DEFAULTS,
  SISTER_STATIC_TAGLINES,
} from "./dj-sister-static.js";

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
//                        (history itself keeps up to HISTORY_CAP = 3000)
//   artistWindow       - how many recent songs the per-artist budget looks back over
//   artistCap          - max plays of any one artist within that window
//   endlessQueueCount  - songs Never-Ending Queue adds on each refill
//   strictFill         - when true, never drop song memory just to fill a short batch
  //   sameArtistBatchEnabled — Booth: automatic same-artist showcase
  //     (overrides unique-artist harden).
  //   loved/hated/requestedReactionSetEnabled — Most Loved / Most Hated /
  //     Most Requested sets (Loved/Hated need 5 songs at 5+ reactions;
  //     Requested needs 5 songs at 5+ guest requests).
  //   specialSetEveryN — shared once-per-X cadence for Same Artist + the
  //     three crowd sets (default 5).
export const RANDOMNESS_DEFAULTS = {
  songMemory: 500,
  artistWindow: 30,
  artistCap: 1,
  endlessQueueCount: 5,
  strictFill: true,
  sameArtistBatchEnabled: true,
  lovedReactionSetEnabled: true,
  hatedReactionSetEnabled: true,
  requestedReactionSetEnabled: true,
  specialSetEveryN: 5,
};

// Generous sanity bounds so a typo can't wedge the picker (e.g. a 10-million
// song memory or a zero cap).
const RANDOMNESS_BOUNDS = {
  songMemory: { min: 1, max: 10000 },
  artistWindow: { min: 1, max: 1000 },
  artistCap: { min: 1, max: 100 },
  endlessQueueCount: { min: 1, max: 100 },
  specialSetEveryN: { min: 1, max: 100 },
};

const RANDOMNESS_INT_KEYS = [
  "songMemory",
  "artistWindow",
  "artistCap",
  "endlessQueueCount",
  "specialSetEveryN",
];

const SPECIAL_SET_EVERY_ALIASES = [
  "specialSetEveryN",
  "lovedReactionSetEveryN",
  "hatedReactionSetEveryN",
  "sameArtistBatchEveryN",
];

function resolveSpecialSetEveryN(s = {}) {
  for (const key of SPECIAL_SET_EVERY_ALIASES) {
    if (s[key] != null) {
      return clampInt(
        s[key],
        RANDOMNESS_DEFAULTS.specialSetEveryN,
        RANDOMNESS_BOUNDS.specialSetEveryN
      );
    }
  }
  return RANDOMNESS_DEFAULTS.specialSetEveryN;
}

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
  const specialEvery = resolveSpecialSetEveryN(s);
  out.specialSetEveryN = specialEvery;
  // Legacy aliases — one cadence for Same Artist / Loved / Hated / Requested.
  out.sameArtistBatchEveryN = specialEvery;
  out.lovedReactionSetEveryN = specialEvery;
  out.hatedReactionSetEveryN = specialEvery;
  out.strictFill =
    typeof s.strictFill === "boolean" ? s.strictFill : RANDOMNESS_DEFAULTS.strictFill;
  out.sameArtistBatchEnabled =
    typeof s.sameArtistBatchEnabled === "boolean"
      ? s.sameArtistBatchEnabled
      : RANDOMNESS_DEFAULTS.sameArtistBatchEnabled;
  out.lovedReactionSetEnabled =
    typeof s.lovedReactionSetEnabled === "boolean"
      ? s.lovedReactionSetEnabled
      : RANDOMNESS_DEFAULTS.lovedReactionSetEnabled;
  out.hatedReactionSetEnabled =
    typeof s.hatedReactionSetEnabled === "boolean"
      ? s.hatedReactionSetEnabled
      : RANDOMNESS_DEFAULTS.hatedReactionSetEnabled;
  out.requestedReactionSetEnabled =
    typeof s.requestedReactionSetEnabled === "boolean"
      ? s.requestedReactionSetEnabled
      : RANDOMNESS_DEFAULTS.requestedReactionSetEnabled;
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

// Guest Set Request fairness (main-search artist sets). On by default so a
// party night starts with one set per hour unless the host opens it up.
export const SET_REQUEST_FAIRNESS_DEFAULTS = {
  setRequestFairnessEnabled: true,
  setRequestFairnessMax: 1,
  setRequestFairnessWindowMinutes: 60,
};

const SET_REQUEST_FAIRNESS_BOUNDS = {
  setRequestFairnessMax: { min: 1, max: 10 },
  setRequestFairnessWindowMinutes: { min: 1, max: 1440 },
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

export function getSetRequestFairnessSettings() {
  const s = loadSettings();
  const song = getRequestFairnessSettings();
  return {
    setRequestFairnessEnabled:
      typeof s.setRequestFairnessEnabled === "boolean"
        ? s.setRequestFairnessEnabled
        : SET_REQUEST_FAIRNESS_DEFAULTS.setRequestFairnessEnabled,
    setRequestFairnessMax: clampInt(
      s.setRequestFairnessMax,
      SET_REQUEST_FAIRNESS_DEFAULTS.setRequestFairnessMax,
      SET_REQUEST_FAIRNESS_BOUNDS.setRequestFairnessMax
    ),
    setRequestFairnessWindowMinutes: clampInt(
      // Migrate pre-10.1.x hour setting (1 hour → 60 minutes).
      s.setRequestFairnessWindowMinutes != null
        ? s.setRequestFairnessWindowMinutes
        : s.setRequestFairnessWindowHours != null
          ? Number(s.setRequestFairnessWindowHours) * 60
          : SET_REQUEST_FAIRNESS_DEFAULTS.setRequestFairnessWindowMinutes,
      SET_REQUEST_FAIRNESS_DEFAULTS.setRequestFairnessWindowMinutes,
      SET_REQUEST_FAIRNESS_BOUNDS.setRequestFairnessWindowMinutes
    ),
    // Host PIN bypass is shared with song-request fairness.
    requestFairnessHostBypass: song.requestFairnessHostBypass,
  };
}

export function setSetRequestFairnessSettings(partial = {}) {
  const next = { ...loadSettings() };
  for (const key of Object.keys(SET_REQUEST_FAIRNESS_BOUNDS)) {
    if (partial[key] != null) {
      next[key] = clampInt(
        partial[key],
        next[key] ?? SET_REQUEST_FAIRNESS_DEFAULTS[key],
        SET_REQUEST_FAIRNESS_BOUNDS[key]
      );
    }
  }
  if (partial.setRequestFairnessEnabled != null) {
    next.setRequestFairnessEnabled = !!partial.setRequestFairnessEnabled;
  }
  saveSettings(next);
  return getSetRequestFairnessSettings();
}

/** Epoch ms; request-log events at or before this are ignored by fairness. */
export function getFairnessResetAt() {
  const n = Number(loadSettings().fairnessResetAt);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Host Reset Fairness — clears rolling song + Set Request quotas, keeps Stats. */
export function resetFairnessQuotas(now = Date.now()) {
  const at = Math.max(0, Math.floor(Number(now) || Date.now()));
  saveSettings({ ...loadSettings(), fairnessResetAt: at });
  return getFairnessResetAt();
}

// DJ voice announcements (Home Assistant TTS between sets). Off by default.
// Persona fields (name / icon / intro % / max words) live here too; the
// enable toggle stays a Controls switch and is saved independently.
export const DJ_VOICE_DEFAULTS = {
  djVoiceEnabled: true,
  djName: "Party DJ",
  // Seeded starter from public/dj-icons/headphones.png → data/dj-icons/.
  // Fresh installs use this; hosts can upload/rename freely.
  djIcon: "dj-icon-headphones.png",
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
  // Artist-line quotes under the DJ name on Now Playing / Up Next / queue.
  djTaglines: [...DJ_TAGLINES],
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
  // Co-host roster. Default Holy Roller only so existing parties are unchanged.
  djRosterMode: "holy-roller",
  djMixHolyRollerPercent: 70,
  djBanterPercent: 15,
  djSisterStatic: {
    ...SISTER_STATIC_PERSONA_DEFAULTS,
    djTaglines: [...SISTER_STATIC_TAGLINES],
  },
};

export const DJ_PERSONA_HOLY_ROLLER = "holy-roller";
export const DJ_PERSONA_SISTER_STATIC = "sister-static";
export const DJ_PERSONA_IDS = [
  DJ_PERSONA_HOLY_ROLLER,
  DJ_PERSONA_SISTER_STATIC,
];
export const DJ_ROSTER_MODES = [
  DJ_PERSONA_HOLY_ROLLER,
  DJ_PERSONA_SISTER_STATIC,
  "mix",
];
export const DJ_MIX_PERCENT_BOUNDS = { min: 0, max: 100 };
export const DJ_BANTER_PERCENT_BOUNDS = { min: 0, max: 100 };

export function normalizeDjPersonaId(
  value,
  fallback = DJ_PERSONA_HOLY_ROLLER
) {
  const id = String(value || "")
    .trim()
    .toLowerCase();
  return DJ_PERSONA_IDS.includes(id) ? id : fallback;
}

export function normalizeDjRosterMode(
  value,
  fallback = DJ_VOICE_DEFAULTS.djRosterMode
) {
  const id = String(value || "")
    .trim()
    .toLowerCase();
  return DJ_ROSTER_MODES.includes(id) ? id : fallback;
}

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
export const DJ_ICON_DEFAULT_URL = "/dj-icons/headphones.png";
export const DJ_ICON_SS_DEFAULT_URL = "/dj-icons/ss-headphones.png";
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

export function djIconUrl(iconName, fallbackUrl = DJ_ICON_DEFAULT_URL) {
  const name = cleanDjIcon(iconName);
  return name ? `/dj-icon/${name}` : fallbackUrl;
}

function resolvePersonaIcon(iconRaw, migrated) {
  let raw = cleanDjIcon(iconRaw);
  if (raw && migrated?.has(raw)) raw = migrated.get(raw);
  if (!raw) return null;
  return djIconExists(raw) ? raw : null;
}

/**
 * Normalize a Sister Static (or generic nested) persona patch.
 * @param {object|null|undefined} raw
 * @param {object} [fallback]
 */
export function normalizeSisterStaticPersona(
  raw,
  fallback = SISTER_STATIC_PERSONA_DEFAULTS
) {
  const src = raw && typeof raw === "object" ? raw : {};
  const fb = fallback && typeof fallback === "object"
    ? fallback
    : SISTER_STATIC_PERSONA_DEFAULTS;
  let djTtsProvider = normalizeDjTtsProvider(
    src.djTtsProvider ?? fb.djTtsProvider,
    fb.djTtsProvider || "openai_ha"
  );
  const djTtsVoiceOpenAi = normalizeDjTtsVoiceOpenAi(
    src.djTtsVoiceOpenAi ?? fb.djTtsVoiceOpenAi,
    fb.djTtsVoiceOpenAi || "nova"
  );
  const djTtsVoiceElevenlabs = normalizeDjTtsVoiceElevenlabs(
    src.djTtsVoiceElevenlabs ?? fb.djTtsVoiceElevenlabs,
    fb.djTtsVoiceElevenlabs || ""
  );
  if (djTtsProvider === "elevenlabs_ha" && !djTtsVoiceElevenlabs) {
    djTtsProvider = "openai_ha";
  }
  const djTtsVoice =
    djTtsProvider === "openai_ha" ? djTtsVoiceOpenAi : djTtsVoiceElevenlabs;
  const migrated = ensureDjIconHousekeeping();
  const icon = resolvePersonaIcon(src.djIcon !== undefined ? src.djIcon : fb.djIcon, migrated);
  const name =
    cleanDjName(src.djName ?? fb.djName) ||
    SISTER_STATIC_PERSONA_DEFAULTS.djName;
  return {
    id: DJ_PERSONA_SISTER_STATIC,
    djName: name,
    djIcon: icon,
    djIconUrl: djIconUrl(icon, DJ_ICON_SS_DEFAULT_URL),
    djTtsProvider,
    djTtsEngine: djTtsEngineForProvider(djTtsProvider),
    djTtsVoiceOpenAi,
    djTtsVoiceElevenlabs,
    djTtsVoice,
    djTtsSpeed: normalizeDjTtsSpeed(
      src.djTtsSpeed ?? fb.djTtsSpeed,
      fb.djTtsSpeed ?? 1
    ),
    djCharacterIntensity: normalizeDjCharacterIntensity(
      src.djCharacterIntensity ?? fb.djCharacterIntensity,
      fb.djCharacterIntensity || "extra"
    ),
    djCatchphrase: normalizeDjCatchphrase(
      src.djCatchphrase ?? fb.djCatchphrase,
      fb.djCatchphrase ?? ""
    ),
    djBanList: normalizeDjBanList(
      src.djBanList ?? fb.djBanList,
      fb.djBanList ?? ""
    ),
    djPersonaNotes: normalizeDjPersonaNotes(
      src.djPersonaNotes ?? fb.djPersonaNotes,
      fb.djPersonaNotes ?? ""
    ),
    djAlwaysInstructions: normalizeDjAlwaysInstructions(
      src.djAlwaysInstructions ?? fb.djAlwaysInstructions,
      fb.djAlwaysInstructions ?? ""
    ),
    djNeverInstructions: normalizeDjNeverInstructions(
      src.djNeverInstructions ?? fb.djNeverInstructions,
      fb.djNeverInstructions ?? ""
    ),
    djPronunciations: normalizeDjPronunciations(
      src.djPronunciations ?? fb.djPronunciations,
      fb.djPronunciations ?? ""
    ),
    djTaglines: normalizeDjTaglines(
      src.djTaglines ?? fb.djTaglines,
      Array.isArray(fb.djTaglines) && fb.djTaglines.length
        ? fb.djTaglines
        : SISTER_STATIC_TAGLINES
    ),
    djNameIntroPercent: clampInt(
      src.djNameIntroPercent ?? fb.djNameIntroPercent,
      fb.djNameIntroPercent ?? DJ_VOICE_DEFAULTS.djNameIntroPercent,
      DJ_NAME_INTRO_BOUNDS
    ),
    djAnnounceMaxWords: clampInt(
      src.djAnnounceMaxWords ?? fb.djAnnounceMaxWords,
      fb.djAnnounceMaxWords ?? DJ_VOICE_DEFAULTS.djAnnounceMaxWords,
      DJ_ANNOUNCE_WORDS_BOUNDS
    ),
  };
}

function holyRollerPersonaFromVoice(dj) {
  return {
    id: DJ_PERSONA_HOLY_ROLLER,
    djName: dj.djName,
    djIcon: dj.djIcon,
    djIconUrl: dj.djIconUrl,
    djTtsProvider: dj.djTtsProvider,
    djTtsEngine: dj.djTtsEngine,
    djTtsVoiceOpenAi: dj.djTtsVoiceOpenAi,
    djTtsVoiceElevenlabs: dj.djTtsVoiceElevenlabs,
    djTtsVoice: dj.djTtsVoice,
    djTtsSpeed: dj.djTtsSpeed,
    djCharacterIntensity: dj.djCharacterIntensity,
    djCatchphrase: dj.djCatchphrase,
    djBanList: dj.djBanList,
    djPersonaNotes: dj.djPersonaNotes,
    djAlwaysInstructions: dj.djAlwaysInstructions,
    djNeverInstructions: dj.djNeverInstructions,
    djPronunciations: dj.djPronunciations,
    djTaglines: dj.djTaglines,
    djNameIntroPercent: dj.djNameIntroPercent,
    djAnnounceMaxWords: dj.djAnnounceMaxWords,
  };
}

/** Resolved persona profile. Holy Roller is the flat DJ Voice settings. */
export function getDjPersona(id = DJ_PERSONA_HOLY_ROLLER) {
  const personaId = normalizeDjPersonaId(id);
  const dj = getDjVoiceSettings();
  if (personaId === DJ_PERSONA_HOLY_ROLLER) {
    return holyRollerPersonaFromVoice(dj);
  }
  const stored = loadSettings()?.djPersonas?.[DJ_PERSONA_SISTER_STATIC];
  return normalizeSisterStaticPersona(stored, SISTER_STATIC_PERSONA_DEFAULTS);
}

export function getDjRosterSettings() {
  const s = loadSettings();
  return {
    djRosterMode: normalizeDjRosterMode(
      s.djRosterMode,
      DJ_VOICE_DEFAULTS.djRosterMode
    ),
    djMixHolyRollerPercent: clampInt(
      s.djMixHolyRollerPercent,
      DJ_VOICE_DEFAULTS.djMixHolyRollerPercent,
      DJ_MIX_PERCENT_BOUNDS
    ),
    djBanterPercent: clampInt(
      s.djBanterPercent,
      DJ_VOICE_DEFAULTS.djBanterPercent,
      DJ_BANTER_PERCENT_BOUNDS
    ),
  };
}

// Icon seed/migrate touches the filesystem (readdir/rename). Run once per
// process — never on every getDjVoiceSettings() call (Random sampling used to
// invoke that per track via isClosingTime and stall Add Random for minutes).
let djIconHousekeepingDone = false;
let djIconMigrationMap = new Map();
function ensureDjIconHousekeeping() {
  if (djIconHousekeepingDone) return djIconMigrationMap;
  djIconHousekeepingDone = true;
  seedStarterDjIcons();
  djIconMigrationMap = new Map([
    ...migrateLegacyIcons(),
    ...migrateDjIconFilenames(),
  ]);
  return djIconMigrationMap;
}

/** Test hook: allow unit tests to re-run icon housekeeping. */
export function resetDjIconHousekeepingForTests() {
  djIconHousekeepingDone = false;
  djIconMigrationMap = new Map();
}

export function getDjVoiceSettings() {
  const s = loadSettings();
  const name = cleanDjName(s.djName);
  const migrated = ensureDjIconHousekeeping();
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
    djTaglines: normalizeDjTaglines(
      s.djTaglines,
      DJ_VOICE_DEFAULTS.djTaglines
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
    djRosterMode: normalizeDjRosterMode(
      s.djRosterMode,
      DJ_VOICE_DEFAULTS.djRosterMode
    ),
    djMixHolyRollerPercent: clampInt(
      s.djMixHolyRollerPercent,
      DJ_VOICE_DEFAULTS.djMixHolyRollerPercent,
      DJ_MIX_PERCENT_BOUNDS
    ),
    djBanterPercent: clampInt(
      s.djBanterPercent,
      DJ_VOICE_DEFAULTS.djBanterPercent,
      DJ_BANTER_PERCENT_BOUNDS
    ),
    djSisterStatic: normalizeSisterStaticPersona(
      s.djPersonas?.[DJ_PERSONA_SISTER_STATIC]
    ),
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
  if (partial.djTaglines != null) {
    next.djTaglines = normalizeDjTaglines(
      partial.djTaglines,
      DJ_VOICE_DEFAULTS.djTaglines
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
  if (partial.djRosterMode != null) {
    next.djRosterMode = normalizeDjRosterMode(
      partial.djRosterMode,
      next.djRosterMode ?? DJ_VOICE_DEFAULTS.djRosterMode
    );
  }
  if (partial.djMixHolyRollerPercent != null) {
    next.djMixHolyRollerPercent = clampInt(
      partial.djMixHolyRollerPercent,
      next.djMixHolyRollerPercent ?? DJ_VOICE_DEFAULTS.djMixHolyRollerPercent,
      DJ_MIX_PERCENT_BOUNDS
    );
  }
  if (partial.djBanterPercent != null) {
    next.djBanterPercent = clampInt(
      partial.djBanterPercent,
      next.djBanterPercent ?? DJ_VOICE_DEFAULTS.djBanterPercent,
      DJ_BANTER_PERCENT_BOUNDS
    );
  }
  const sisterPatch =
    partial.djSisterStatic != null
      ? partial.djSisterStatic
      : partial.djPersonas?.[DJ_PERSONA_SISTER_STATIC];
  if (sisterPatch != null && typeof sisterPatch === "object") {
    const current = next.djPersonas?.[DJ_PERSONA_SISTER_STATIC] || {};
    const resolved = normalizeSisterStaticPersona(
      { ...current, ...sisterPatch },
      SISTER_STATIC_PERSONA_DEFAULTS
    );
    next.djPersonas = {
      ...(next.djPersonas && typeof next.djPersonas === "object"
        ? next.djPersonas
        : {}),
      [DJ_PERSONA_SISTER_STATIC]: {
        djName: resolved.djName,
        djIcon: resolved.djIcon,
        djTtsProvider: resolved.djTtsProvider,
        djTtsVoiceOpenAi: resolved.djTtsVoiceOpenAi,
        djTtsVoiceElevenlabs: resolved.djTtsVoiceElevenlabs,
        djTtsSpeed: resolved.djTtsSpeed,
        djCharacterIntensity: resolved.djCharacterIntensity,
        djCatchphrase: resolved.djCatchphrase,
        djBanList: resolved.djBanList,
        djPersonaNotes: resolved.djPersonaNotes,
        djAlwaysInstructions: resolved.djAlwaysInstructions,
        djNeverInstructions: resolved.djNeverInstructions,
        djPronunciations: resolved.djPronunciations,
        djTaglines: resolved.djTaglines,
        djNameIntroPercent: resolved.djNameIntroPercent,
        djAnnounceMaxWords: resolved.djAnnounceMaxWords,
      },
    };
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
// Font sizes are Look-page pixel picks applied as CSS variables.
export const BRAND_FONT_PX = {
  header: { min: 16, max: 80, default: 36 },
  subtitle: { min: 10, max: 48, default: 18 },
  version: { min: 8, max: 32, default: 11 },
};

/** Legacy sm/md/lg/xl presets → scale against each role's default. */
const BRAND_FONT_LEGACY_SCALE = {
  sm: 0.85,
  md: 1,
  lg: 1.2,
  xl: 1.4,
};

/**
 * @param {unknown} value
 * @param {"header"|"subtitle"|"version"} [role]
 */
export function normalizeBrandFontSize(value, role = "header") {
  const cfg = BRAND_FONT_PX[role] || BRAND_FONT_PX.header;
  const legacy =
    BRAND_FONT_LEGACY_SCALE[String(value ?? "").trim().toLowerCase()];
  if (legacy != null) {
    return Math.min(
      cfg.max,
      Math.max(cfg.min, Math.round(cfg.default * legacy))
    );
  }
  const raw =
    typeof value === "number"
      ? value
      : Number(String(value ?? "").replace(/px$/i, "").trim());
  if (!Number.isFinite(raw)) return cfg.default;
  return Math.min(cfg.max, Math.max(cfg.min, Math.round(raw)));
}

export const BRANDING_DEFAULTS = {
  eventName: "PartyQueue",
  subtitle: "",
  showVersion: true,
  // Up Next pills: matched genre + From Playlists next to origin badge.
  showQueueGenre: false,
  // Desktop (≥960px) type. Phone keys below fall back to these when unset.
  headerFontSize: BRAND_FONT_PX.header.default,
  subtitleFontSize: BRAND_FONT_PX.subtitle.default,
  versionFontSize: BRAND_FONT_PX.version.default,
  // Match the long-standing desktop brand look (ALL CAPS title + tagline).
  headerAllCaps: true,
  subtitleAllCaps: true,
  // Phone (<960px) type — same defaults; hosts can tune independently.
  headerFontSizeMobile: BRAND_FONT_PX.header.default,
  subtitleFontSizeMobile: BRAND_FONT_PX.subtitle.default,
  versionFontSizeMobile: BRAND_FONT_PX.version.default,
  headerAllCapsMobile: true,
  subtitleAllCapsMobile: true,
  heroBanner: null, // null = built-in public/hero.jpg; otherwise a data/banners file
  // Phone header banner; null falls back to heroBanner (then built-in hero.jpg).
  heroBannerMobile: null,
};
const BRANDING_MAXLEN = { eventName: 60, subtitle: 120 };

function cleanText(value, max) {
  if (typeof value !== "string") return null;
  // Strip control chars (incl. newlines) so the header stays single-line.
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

/** @param {string|null|undefined} name @param {Map<string, string>} renamed */
function normalizeBannerName(name, renamed) {
  let next = typeof name === "string" ? name : null;
  if (next && renamed.has(next)) next = renamed.get(next);
  if (next && !bannerExists(next)) next = null;
  return next;
}

export function getBrandingSettings() {
  const s = loadSettings();
  const name = cleanText(s.eventName, BRANDING_MAXLEN.eventName);
  const sub = cleanText(s.subtitle, BRANDING_MAXLEN.subtitle);
  const renamed = migrateBannerFilenames();
  let heroBanner = normalizeBannerName(s.heroBanner, renamed);
  let heroBannerMobile = normalizeBannerName(s.heroBannerMobile, renamed);
  const migratedDesktop =
    typeof s.heroBanner === "string" &&
    renamed.has(s.heroBanner) &&
    heroBanner === renamed.get(s.heroBanner);
  const migratedMobile =
    typeof s.heroBannerMobile === "string" &&
    renamed.has(s.heroBannerMobile) &&
    heroBannerMobile === renamed.get(s.heroBannerMobile);
  if (migratedDesktop || migratedMobile) {
    try {
      saveSettings({
        ...s,
        ...(migratedDesktop ? { heroBanner } : {}),
        ...(migratedMobile ? { heroBannerMobile } : {}),
      });
    } catch {
      /* migration is best-effort */
    }
  }
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
    headerFontSize: normalizeBrandFontSize(
      s.headerFontSize ?? BRANDING_DEFAULTS.headerFontSize,
      "header"
    ),
    subtitleFontSize: normalizeBrandFontSize(
      s.subtitleFontSize ?? BRANDING_DEFAULTS.subtitleFontSize,
      "subtitle"
    ),
    versionFontSize: normalizeBrandFontSize(
      s.versionFontSize ?? BRANDING_DEFAULTS.versionFontSize,
      "version"
    ),
    headerAllCaps:
      typeof s.headerAllCaps === "boolean"
        ? s.headerAllCaps
        : BRANDING_DEFAULTS.headerAllCaps,
    subtitleAllCaps:
      typeof s.subtitleAllCaps === "boolean"
        ? s.subtitleAllCaps
        : BRANDING_DEFAULTS.subtitleAllCaps,
    // Missing mobile keys inherit the desktop values so upgrades keep one look.
    headerFontSizeMobile: normalizeBrandFontSize(
      s.headerFontSizeMobile ??
        s.headerFontSize ??
        BRANDING_DEFAULTS.headerFontSizeMobile,
      "header"
    ),
    subtitleFontSizeMobile: normalizeBrandFontSize(
      s.subtitleFontSizeMobile ??
        s.subtitleFontSize ??
        BRANDING_DEFAULTS.subtitleFontSizeMobile,
      "subtitle"
    ),
    versionFontSizeMobile: normalizeBrandFontSize(
      s.versionFontSizeMobile ??
        s.versionFontSize ??
        BRANDING_DEFAULTS.versionFontSizeMobile,
      "version"
    ),
    headerAllCapsMobile:
      typeof s.headerAllCapsMobile === "boolean"
        ? s.headerAllCapsMobile
        : typeof s.headerAllCaps === "boolean"
          ? s.headerAllCaps
          : BRANDING_DEFAULTS.headerAllCapsMobile,
    subtitleAllCapsMobile:
      typeof s.subtitleAllCapsMobile === "boolean"
        ? s.subtitleAllCapsMobile
        : typeof s.subtitleAllCaps === "boolean"
          ? s.subtitleAllCaps
          : BRANDING_DEFAULTS.subtitleAllCapsMobile,
    heroBanner,
    heroBannerMobile,
  };
}

/**
 * Resolve which banner file to serve for a viewport slot.
 * Mobile null falls back to desktop; both null → built-in hero.jpg at the route.
 * @param {"desktop"|"mobile"} [slot]
 * @returns {string|null}
 */
export function resolveBannerForSlot(slot = "desktop") {
  const b = getBrandingSettings();
  if (slot === "mobile") return b.heroBannerMobile || b.heroBanner || null;
  return b.heroBanner || null;
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
  if (partial.headerFontSize != null) {
    next.headerFontSize = normalizeBrandFontSize(
      partial.headerFontSize,
      "header"
    );
  }
  if (partial.subtitleFontSize != null) {
    next.subtitleFontSize = normalizeBrandFontSize(
      partial.subtitleFontSize,
      "subtitle"
    );
  }
  if (partial.versionFontSize != null) {
    next.versionFontSize = normalizeBrandFontSize(
      partial.versionFontSize,
      "version"
    );
  }
  if (partial.headerAllCaps != null) {
    next.headerAllCaps = !!partial.headerAllCaps;
  }
  if (partial.subtitleAllCaps != null) {
    next.subtitleAllCaps = !!partial.subtitleAllCaps;
  }
  if (partial.headerFontSizeMobile != null) {
    next.headerFontSizeMobile = normalizeBrandFontSize(
      partial.headerFontSizeMobile,
      "header"
    );
  }
  if (partial.subtitleFontSizeMobile != null) {
    next.subtitleFontSizeMobile = normalizeBrandFontSize(
      partial.subtitleFontSizeMobile,
      "subtitle"
    );
  }
  if (partial.versionFontSizeMobile != null) {
    next.versionFontSizeMobile = normalizeBrandFontSize(
      partial.versionFontSizeMobile,
      "version"
    );
  }
  if (partial.headerAllCapsMobile != null) {
    next.headerAllCapsMobile = !!partial.headerAllCapsMobile;
  }
  if (partial.subtitleAllCapsMobile != null) {
    next.subtitleAllCapsMobile = !!partial.subtitleAllCapsMobile;
  }
  if (partial.heroBanner !== undefined) {
    next.heroBanner =
      typeof partial.heroBanner === "string" && partial.heroBanner ? partial.heroBanner : null;
  }
  if (partial.heroBannerMobile !== undefined) {
    next.heroBannerMobile =
      typeof partial.heroBannerMobile === "string" && partial.heroBannerMobile
        ? partial.heroBannerMobile
        : null;
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

/** @returns {Record<string, string>} room name → player type id */
export function getSonosPlayerTypes() {
  const raw = loadSettings().sonosPlayerTypes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [room, typeId] of Object.entries(raw)) {
    const name = cleanRoomName(room);
    const type = normalizeSonosPlayerType(typeId);
    if (name && type) out[name] = type;
  }
  return out;
}

/**
 * Assign a Sonos player-type icon to a room (persisted).
 * @param {string} room
 * @param {string} typeId
 * @returns {{ room: string, type: string, types: Record<string, string> }}
 */
export function setSonosPlayerType(room, typeId) {
  const name = cleanRoomName(room);
  if (!name) throw new Error("Missing room name.");
  const type = normalizeSonosPlayerType(typeId);
  if (!type) throw new Error("Unknown Sonos player type.");

  const next = { ...loadSettings() };
  const map = { ...getSonosPlayerTypes() };
  // Keep the first-seen room spelling; replace value case-insensitively.
  let key = name;
  for (const existing of Object.keys(map)) {
    if (existing.toLowerCase() === name.toLowerCase()) {
      key = existing;
      break;
    }
  }
  map[key] = type;
  next.sonosPlayerTypes = map;
  saveSettings(next);
  return { room: key, type, types: getSonosPlayerTypes() };
}

/** @param {string} room */
export function getSonosPlayerTypeForRoom(room) {
  return lookupSonosPlayerType(getSonosPlayerTypes(), room);
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
  if (partial.lovedReactionSetEnabled != null) {
    next.lovedReactionSetEnabled = !!partial.lovedReactionSetEnabled;
  }
  if (partial.hatedReactionSetEnabled != null) {
    next.hatedReactionSetEnabled = !!partial.hatedReactionSetEnabled;
  }
  if (partial.requestedReactionSetEnabled != null) {
    next.requestedReactionSetEnabled = !!partial.requestedReactionSetEnabled;
  }
  const everyAlias = SPECIAL_SET_EVERY_ALIASES.find((key) => partial[key] != null);
  if (everyAlias) {
    const everyN = clampInt(
      partial[everyAlias],
      current.specialSetEveryN ?? RANDOMNESS_DEFAULTS.specialSetEveryN,
      RANDOMNESS_BOUNDS.specialSetEveryN
    );
    next.specialSetEveryN = everyN;
    next.sameArtistBatchEveryN = everyN;
    next.lovedReactionSetEveryN = everyN;
    next.hatedReactionSetEveryN = everyN;
  }
  saveSettings(next);
  return getRandomnessSettings();
}
