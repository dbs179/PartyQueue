// Holiday packs for the Mood chips and for keeping seasonal tracks out of
// ordinary Random. The host picks Independence Day, Halloween, Christmas, or
// New Years. The date windows below only decide when those songs may appear
// in ordinary Random. First matching window wins.

import {
  isHolidayPlaylistName,
  isHolidayTrack,
} from "./holiday-tracks.js";

/** @typedef {{ id: string, label: string, searchQueries: string[], lastfmTags?: string[], usesChristmasMatchers?: boolean, title?: RegExp, album?: RegExp, playlist?: RegExp }} HolidayPack */

/** @type {HolidayPack[]} */
const PACKS = [
  {
    id: "valentines",
    label: "Valentine's",
    searchQueries: ["valentine"],
    title: /\bvalentine\b/i,
    album: /\bvalentine\b/i,
    playlist: /valentine/i,
  },
  {
    id: "stpatricks",
    label: "St. Patrick's",
    searchQueries: ["whiskey in the jar", "danny boy"],
    title:
      /st\.?\s*patrick|saint patrick|danny boy|whiskey in the jar|the wild rover|finnegan'?s wake|molly malone|galway girl|when irish eyes are smiling/i,
    album: /st\.?\s*patrick|saint patrick/i,
    playlist: /st\.?\s*patrick|saint patrick|paddy'?s|paddys/i,
  },
  {
    id: "easter",
    label: "Easter",
    searchQueries: ["easter", "peter cottontail"],
    title: /\beaster\b|peter cottontail/i,
    album: /\beaster\b/i,
    playlist: /\beaster\b/i,
  },
  {
    id: "july4",
    label: "Independence Day",
    searchQueries: ["god bless america", "star spangled banner", "independence day"],
    title:
      /star[- ]spangled banner|god bless america|america the beautiful|yankee doodle|god bless the u\.?s\.?a|born in the u\.?s\.?a|fourth of july|4th of july|independence day/i,
    album: /fourth of july|4th of july|patriotic/i,
    playlist: /fourth of july|4th of july|july 4|patriotic|independence day/i,
  },
  {
    id: "halloween",
    label: "Halloween",
    // Last.fm tag.getTopTracks for "halloween" (~15k tags). The top of the
    // chart is party Halloween music, including songs that never say it.
    lastfmTags: ["halloween"],
    searchQueries: ["halloween", "monster mash", "thriller"],
    title:
      /halloween|monster mash|\bthriller\b|ghostbusters|this is halloween|nightmare before christmas|addams family|werewolves of london|dead man'?s party|somebody'?s watching me|purple people eater|grim grinning ghosts|i put a spell on you/i,
    album: /halloween|\bthriller\b|nightmare before christmas/i,
    playlist: /halloween|monster mash/i,
  },
  {
    id: "thanksgiving",
    label: "Thanksgiving",
    searchQueries: ["thanksgiving"],
    title: /thanksgiving|over the river and through the woods/i,
    album: /thanksgiving/i,
    playlist: /thanksgiving/i,
  },
  {
    id: "newyears",
    label: "New Years",
    searchQueries: ["auld lang syne", "new year's eve"],
    title: /auld lang syne|happy new year|new year'?s eve|\bnew years?\b/i,
    album: /new years?/i,
    playlist: /new years?/i,
  },
  {
    id: "christmas",
    label: "Christmas",
    lastfmTags: ["christmas"],
    searchQueries: ["christmas"],
    usesChristmasMatchers: true,
  },
];

/** Mood chips. Other packs stay for out-of-season filtering only. */
const SELECTABLE_IDS = new Set(["july4", "halloween", "christmas", "newyears"]);

const PACKS_BY_ID = new Map(PACKS.map((p) => [p.id, p]));

/** @param {string|null|undefined} value */
export function normalizeHolidayId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return PACKS_BY_ID.has(id) ? id : null;
}

/** Id of a Mood holiday chip, or null. */
export function selectableHolidayId(value) {
  const id = normalizeHolidayId(value);
  return id && SELECTABLE_IDS.has(id) ? id : null;
}

/** @param {string|null|undefined} value */
export function holidayPack(value) {
  const id = normalizeHolidayId(value);
  return id ? PACKS_BY_ID.get(id) : null;
}

export function holidayLabel(value) {
  return holidayPack(value)?.label || null;
}

/**
 * Gregorian computus. Month is 1–12.
 * @param {number} year
 */
export function easterSunday(year) {
  const y = Math.floor(year);
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year: y, month, day };
}

/** Day of November (1–30) for US Thanksgiving, the fourth Thursday. */
export function thanksgivingDay(year) {
  const nov1 = new Date(year, 10, 1, 12);
  const firstThursday = 1 + ((4 - nov1.getDay() + 7) % 7);
  return firstThursday + 21;
}

function monthDay(date) {
  return date.getMonth() + 1;
}

function inSpan(date, startMonth, startDay, endMonth, endDay) {
  const cur = monthDay(date) * 100 + date.getDate();
  const start = startMonth * 100 + startDay;
  const end = endMonth * 100 + endDay;
  if (start <= end) return cur >= start && cur <= end;
  return cur >= start || cur <= end;
}

function inEasterWindow(date) {
  const easter = easterSunday(date.getFullYear());
  const end = new Date(easter.year, easter.month - 1, easter.day, 12);
  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  const cur = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  return cur >= start && cur <= end;
}

function inThanksgiving(date) {
  if (date.getMonth() !== 10) return false;
  const tg = thanksgivingDay(date.getFullYear());
  const monday = tg - 3;
  const day = date.getDate();
  return day >= monday && day <= tg;
}

function isChristmasDate(date) {
  return inSpan(date, 11, 15, 1, 2);
}

/**
 * The holiday in season on `date`, or null. Local calendar date, not UTC.
 * @param {Date} [date]
 * @returns {HolidayPack|null}
 */
export function activeHoliday(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  if (inSpan(date, 2, 1, 2, 14)) return PACKS_BY_ID.get("valentines");
  if (inSpan(date, 3, 1, 3, 17)) return PACKS_BY_ID.get("stpatricks");
  if (inEasterWindow(date)) return PACKS_BY_ID.get("easter");
  if (inSpan(date, 6, 28, 7, 4)) return PACKS_BY_ID.get("july4");
  if (date.getMonth() === 9) return PACKS_BY_ID.get("halloween");
  if (inThanksgiving(date)) return PACKS_BY_ID.get("thanksgiving");
  if (inSpan(date, 12, 31, 1, 1)) return PACKS_BY_ID.get("newyears");
  if (isChristmasDate(date)) return PACKS_BY_ID.get("christmas");
  return null;
}

function trackMatchesPack(track, pack) {
  if (!pack) return false;
  if (pack.usesChristmasMatchers) return isHolidayTrack(track);
  const name = String(track?.name || track?.title || "");
  const album = String(track?.album || "");
  if (pack.title && pack.title.test(name)) return true;
  if (album && pack.album && pack.album.test(album)) return true;
  return false;
}

function playlistMatchesPack(name, pack) {
  if (!pack) return false;
  if (pack.usesChristmasMatchers) return isHolidayPlaylistName(name);
  return !!pack.playlist && pack.playlist.test(String(name || ""));
}

/** Holiday ids whose title/album phrases match this track. */
export function holidaysMatchingTrack(track = {}) {
  const ids = [];
  for (const pack of PACKS) {
    if (trackMatchesPack(track, pack)) ids.push(pack.id);
  }
  return ids;
}

/** True when this track belongs to `holiday` (pack or id). */
export function trackMatchesHoliday(track, holiday) {
  const pack = typeof holiday === "string" ? holidayPack(holiday) : holiday;
  return trackMatchesPack(track, pack);
}

export function playlistMatchesHoliday(playlist, holiday) {
  const pack = typeof holiday === "string" ? holidayPack(holiday) : holiday;
  return playlistMatchesPack(playlist?.name, pack);
}

/**
 * Skip a holiday track unless that holiday is the one in season.
 * A non-holiday track is never skipped here.
 */
export function isOutOfSeasonHolidayTrack(track = {}, date = new Date()) {
  const ids = holidaysMatchingTrack(track);
  if (!ids.length) return false;
  const active = activeHoliday(date);
  return !active || !ids.includes(active.id);
}

/** Skip a holiday-named playlist unless that holiday is in season. */
export function isOutOfSeasonHolidayPlaylist(playlist = {}, date = new Date()) {
  const ids = [];
  for (const pack of PACKS) {
    if (playlistMatchesPack(playlist?.name, pack)) ids.push(pack.id);
  }
  if (!ids.length) return false;
  const active = activeHoliday(date);
  return !active || !ids.includes(active.id);
}

const SOUND_EFFECT_PHRASE =
  /\bsound effects?\b|\bsfx\b|\bfoley\b|\bsoundscape\b|\bambien(?:ce|t)\b|\bscary sounds\b|\bhorror sounds\b|\bspooky sounds\b|\bhaunted sounds?\b/i;

/** Clips shorter than this are sound effects, not songs. */
const SOUND_EFFECT_MAX_MS = 90_000;

/**
 * True for a sound-effect clip: labeled SFX/ambience, or a known duration
 * under 90 seconds. A missing duration is not enough to drop a song.
 */
export function isSoundEffectTrack(track = {}) {
  const name = String(track?.name || track?.title || "");
  const artist = String(track?.artist || "");
  const album = String(track?.album || "");
  if (SOUND_EFFECT_PHRASE.test(`${name} ${artist} ${album}`)) return true;
  const durationMs = Number(track?.durationMs);
  return Number.isFinite(durationMs) && durationMs > 0 && durationMs < SOUND_EFFECT_MAX_MS;
}

function looseText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Loose artist/title equality. Short fragments do not substring-match. */
function looseSame(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length < b.length ? a : b;
  if (shorter.length < 4) return false;
  return a.includes(b) || b.includes(a);
}

function chartRows(chartTracks) {
  const rows = [];
  for (const row of chartTracks || []) {
    const name = looseText(row?.name);
    const artist = looseText(String(row?.artist || "").split(",")[0]);
    if (name && artist) rows.push({ name, artist });
  }
  return rows;
}

/**
 * True when `track` is the same recording as a Last.fm holiday-chart row.
 * Used so library songs tagged for the holiday count even if the title
 * never says "Halloween".
 */
export function trackOnHolidayChart(track, chartTracks) {
  const rows = chartRows(chartTracks);
  if (!rows.length) return false;
  const name = looseText(track?.name || track?.title);
  const artist = looseText(String(track?.artist || "").split(",")[0]);
  if (!name || !artist) return false;
  return rows.some((row) => looseSame(name, row.name) && looseSame(artist, row.artist));
}

/**
 * Keep tracks labeled for `holiday`, plus library tracks on that holiday's
 * Last.fm chart. Sound-effect clips are left out. A playlist name does not
 * pull in the rest of its songs.
 * @param {Array<{ name?: string, tracks?: object[] }>} playlists
 * @param {HolidayPack|string} holiday
 * @param {Array<{ artist?: string, name?: string }>|null} [chartTracks]
 */
export function filterPlaylistsToHoliday(playlists, holiday, chartTracks = null) {
  const pack = typeof holiday === "string" ? holidayPack(holiday) : holiday;
  if (!pack) return [];
  const chart = chartRows(chartTracks);
  const out = [];
  for (const pl of playlists || []) {
    const tracks = (pl?.tracks || []).filter(
      (t) =>
        !isSoundEffectTrack(t) &&
        (holidaysMatchingTrack(t).includes(pack.id) || trackOnHolidayChart(t, chart))
    );
    if (tracks.length) out.push({ ...pl, tracks });
  }
  return out;
}
