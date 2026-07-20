// Party recap stats + DJ copy for Closing Time (last call).

import { getRequests, summarizeRequests, topRequesters } from "./request-log.js";
import {
  pickGuestNotes,
  isGuestBirthdayToday,
  birthdayShoutLabel,
} from "./guest-profiles.js";
import { getDjVoiceSettings } from "./settings.js";
import { getEndOfNightTrack } from "./closing-time.js";

const RECAP_WINDOW_HOURS = 12;

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Distinct requesters in the window whose birthday is today.
 * @returns {Array<{ name: string, label: string }>}
 */
export function tonightBirthdayGuests(events, sinceTs = 0, now = new Date()) {
  const names = new Set();
  for (const e of Array.isArray(events) ? events : []) {
    if ((Number(e?.ts) || 0) >= sinceTs && e?.requestedBy) {
      names.add(e.requestedBy);
    }
  }
  return [...names]
    .filter((name) => isGuestBirthdayToday(name, now))
    .map((name) => ({ name, label: birthdayShoutLabel(name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function formatBirthdayRecapBeat(birthdayGuests) {
  const list = Array.isArray(birthdayGuests) ? birthdayGuests : [];
  if (!list.length) return "";
  if (list.length === 1) {
    const g = list[0];
    return pick([
      `And happy birthday to ${g.name}, the ${g.label} — we see you.`,
      `One more time: happy birthday ${g.name}, tonight's ${g.label}.`,
      `Before we wrap — happy birthday to ${g.name}, the ${g.label}.`,
    ]);
  }
  if (list.length === 2) {
    return `And happy birthday to ${list[0].name} and ${list[1].name} — birthday legends tonight.`;
  }
  const head = list
    .slice(0, -1)
    .map((g) => g.name)
    .join(", ");
  const last = list[list.length - 1].name;
  return `And happy birthday to ${head}, and ${last} — birthday energy all night.`;
}

/**
 * Aggregate tonight's requests into a recap payload for overlay + DJ TTS.
 * @returns {{
 *   total: number,
 *   topSongs: Array<{name: string, artist: string, count: number}>,
 *   topArtists: Array<{artist: string, count: number}>,
 *   topRequesters: Array<{name: string, count: number}>,
 *   script: string,
 *   windowHours: number,
 * }}
 */
export function buildPartyRecap() {
  const since = Date.now() - RECAP_WINDOW_HOURS * 60 * 60_000;
  const events = getRequests();
  const stats = summarizeRequests(events, since, 3);
  const requesters = topRequesters(events, since, 3);
  const birthdayGuests = tonightBirthdayGuests(events, since);
  const endSong = getEndOfNightTrack();
  const script = writeRecapScript(stats, requesters, birthdayGuests, endSong);
  return {
    total: stats.total,
    endOfNightName: endSong.name,
    endOfNightArtist: endSong.artist,
    topSongs: stats.topSongs.map((s) => ({
      name: s.name,
      artist: s.artist,
      count: s.count,
    })),
    topArtists: stats.topArtists.map((a) => ({
      artist: a.artist,
      count: a.count,
    })),
    topRequesters: requesters,
    script,
    windowHours: RECAP_WINDOW_HOURS,
  };
}

/** Exported for unit tests. */
export function writeRecapScript(
  stats,
  requesters,
  birthdayGuests = [],
  endSong = null
) {
  const dj = getDjVoiceSettings();
  const night = endSong || getEndOfNightTrack(dj);
  const songLabel = night.name || "last call";
  const maxWords = Math.max(
    28,
    (Number(dj.djAnnounceMaxWords) || 55) +
      (Array.isArray(birthdayGuests) && birthdayGuests.length ? 20 : 0)
  );
  const bits = [];

  bits.push(
    pick([
      "Alright party — last call is coming up.",
      `Before ${songLabel}, let's tip the hat to tonight.`,
      "Almost lights out — here's the night in a nutshell.",
    ])
  );

  if (stats.total > 0) {
    bits.push(
      pick([
        `${stats.total} request${stats.total === 1 ? "" : "s"} hit the booth.`,
        `We logged ${stats.total} song request${stats.total === 1 ? "" : "s"} tonight.`,
      ])
    );
  } else {
    bits.push("Quiet night on the request line — still a solid set.");
  }

  const topSong = stats.topSongs[0];
  if (topSong?.name) {
    const by = topSong.artist ? ` by ${topSong.artist}` : "";
    bits.push(
      pick([
        `Most requested: ${topSong.name}${by}.`,
        `Crowd favorite was ${topSong.name}${by}.`,
      ])
    );
  }

  const topPerson = requesters[0];
  if (topPerson?.name) {
    const noteBits = pickGuestNotes(topPerson.name, 1);
    const noteBit = noteBits[0]
      ? ` ${noteBits[0].endsWith(".") ? noteBits[0] : `${noteBits[0]}.`}`
      : "";
    bits.push(
      pick([
        `Biggest requester: ${topPerson.name} with ${topPerson.count}.${noteBit}`,
        `Shout-out to ${topPerson.name} for keeping the queue fed.${noteBit}`,
      ])
    );
  }

  const birthdayBeat = formatBirthdayRecapBeat(birthdayGuests);
  if (birthdayBeat) bits.push(birthdayBeat);

  bits.push(
    pick([
      `${songLabel} is next — thanks for dancing.`,
      `Here comes ${songLabel}. You were amazing.`,
      `Last call — ${songLabel}. Good night, and thanks for the requests.`,
    ])
  );

  return trimWords(bits.join(" ").replace(/\s+/g, " ").trim(), maxWords);
}

/**
 * Short DJ shout for a searched request (template fallback — no AI).
 */
export function writeRequestShoutTemplate({
  name,
  artist,
  requestedBy,
  dedication = null,
  isBirthday = false,
  birthdayLabel = "birthday star",
  notes = null,
} = {}) {
  const dj = getDjVoiceSettings();
  const forWho = String(dedication || "").trim();
  const maxWords = Math.min(
    isBirthday || forWho ? 55 : 45,
    Math.max(22, Number(dj.djAnnounceMaxWords) || 55)
  );
  const song = String(name || "this next track").trim();
  const who = String(artist || "").trim();
  const by = String(requestedBy || "").trim();
  const noteBits = Array.isArray(notes)
    ? notes.filter((n) => typeof n === "string" && n.trim())
    : by
      ? pickGuestNotes(by, 2)
      : [];

  const parts = [];
  if (by) {
    parts.push(
      pick([
        `Shout-out to ${by}!`,
        `${by} just put one in!`,
        `Coming in hot from ${by}!`,
      ])
    );
  } else {
    parts.push(pick(["Request coming up!", "Someone just scored a request!"]));
  }

  if (isBirthday && by) {
    const label = birthdayLabel || "birthday star";
    parts.push(
      pick([
        `Happy birthday to the ${label}, ${by}!`,
        `${by} is the ${label} tonight — happy birthday!`,
        `Big birthday love for ${by}, our ${label}!`,
      ])
    );
  }

  if (forWho) {
    parts.push(
      pick([
        `This one goes out to ${forWho}.`,
        `Dedicated to ${forWho}.`,
        `Going out to ${forWho}.`,
      ])
    );
  }

  if (who) {
    parts.push(
      pick([
        `Up next: ${song} by ${who}.`,
        `We're spinning ${song} by ${who}.`,
      ])
    );
  } else {
    parts.push(pick([`Up next: ${song}.`, `Here's ${song}.`]));
  }

  for (const note of noteBits) {
    parts.push(note.endsWith(".") ? note : `${note}.`);
  }

  return trimWords(parts.join(" ").replace(/\s+/g, " ").trim(), maxWords);
}

/** @deprecated use writeRequestShoutTemplate or AI writeRequestShoutScript */
export function writeRequestShoutScript(opts) {
  return writeRequestShoutTemplate(opts);
}

function trimWords(text, maxWords) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ").replace(/[.,;:!?]*$/, "")}.`;
}
