// Fun DJ taglines for Now Playing / queue rows.
//
// DJ Voice clips show the host's configured DJ name on the title line; the
// artist line used to always read "PartyQueue". Instead, each clip pulls a
// tagline from this pack ("DJ Spinmaster — Bringing that Heat").
// Picks are remembered in DJ night memory: the same clip keeps its line (no
// poll flicker), and new clips prefer unused taglines until the pack cycles.

import { reserveClipTagline } from "./dj-night-memory.js";

/** @type {string[]} */
export const DJ_TAGLINES = [
  "Bringing that Heat",
  "Rocking from the Pulpit",
  "Preaching to the Choir",
  "Spinning the Good Word",
  "Turning Water into Bangers",
  "Dropping Bass and Blessings",
  "Sermons at 120 BPM",
  "Making the Congregation Dance",
  "Amen to the Encore",
  "Live from the Booth",
  "Certified Floor Filler",
  "Louder Than Your Uncle at Thanksgiving",
  "Fueled by Leftover Pizza",
  "Reading the Room Since Forever",
  "Volume Knob Goes to 11",
  "No Skips, No Mercy",
  "Sponsored by Absolutely Nobody",
  "Two Turntables and a Casserole",
  "Keeping the Neighbors Curious",
  "Bass So Low It Needs a Permit",
  "Playing Your Song Eventually",
  "The Encore Nobody Asked For",
  "Smooth Like Day-Old Coffee",
  "Warming Up Since Lunch",
  "All Killer, Some Filler",
  "Taking Requests, Making Demands",
  "Vibes Curated, Batteries Included",
  "Loud Enough to Wake the HOA",
  "Master of the Slow Fade",
  "Never Met a Chorus He Didn't Like",
  "Beats by the Decade",
  "Shuffling Responsibly",
  "One More Song, He Promises",
  "Bigger Drops Than the Stock Market",
  "Mixing Since the Dial-Up Days",
  "Crossfading Like a Champion",
  "The Real MVP of the Playlist",
  "Running on Fumes and Funk",
  "Turning It Up a Notch, Politely",
  "Heavy Rotation, Light Cardio",
  "Undefeated at Musical Chairs",
  "Air Horn Certified",
  "Now with 20% More Cowbell",
  "Guaranteed Fresh Until Midnight",
  "Spinning Vinyl in Spirit",
  "The Bass Drops at His Command",
  "Everybody's Favorite Opening Act",
  "Closing Time Negotiable",
  "Zero Days Since the Last Banger",
  "Hydrated and Ready to Spin",
];

export const DJ_TAGLINE_MAX_LEN = 60;
export const DJ_TAGLINE_MAX_COUNT = 80;

/**
 * Normalize a host-edited pack (array or newline-separated text). Empty or
 * invalid input falls back to the built-in list so Now Playing always has a
 * line to show.
 * @param {unknown} value
 * @param {string[]} [fallback]
 * @returns {string[]}
 */
export function normalizeDjTaglines(value, fallback = DJ_TAGLINES) {
  const fallbackPack = (
    Array.isArray(fallback) && fallback.length ? fallback : DJ_TAGLINES
  ).map((line) => String(line || "").trim()).filter(Boolean);

  let rawLines;
  if (value == null) return [...fallbackPack];
  if (typeof value === "string") rawLines = value.split(/\r?\n/);
  else if (Array.isArray(value)) rawLines = value;
  else return [...fallbackPack];

  const seen = new Set();
  const out = [];
  for (const raw of rawLines) {
    const line = String(raw || "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, DJ_TAGLINE_MAX_LEN);
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= DJ_TAGLINE_MAX_COUNT) break;
  }
  return out.length ? out : [...fallbackPack];
}

/**
 * Tagline for a DJ clip URL. Stable for the same clip within the night
 * window; new clips avoid taglines already used tonight until the pack
 * is exhausted, then recycle least-recently used.
 * @param {string|null|undefined} uri
 * @param {string[]|string|null|undefined} [pack]
 * @returns {string}
 */
export function taglineForClip(uri, pack) {
  return reserveClipTagline(uri, normalizeDjTaglines(pack, DJ_TAGLINES));
}
