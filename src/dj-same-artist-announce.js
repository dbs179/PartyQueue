/**
 * Same-artist showcase announce lines.
 *
 * Automatic every-N sets already pick one artist. These banks make the DJ
 * say that out loud: scripted intro + LLM blurb, same three-part layout as
 * Most Loved / Most Hated (intro + middle + outro).
 */

/** @param {string} artist */
export function fillArtistTemplate(text, artist) {
  const name = String(artist || "").trim() || "this artist";
  return String(text || "").replace(/\{artist\}/g, name);
}

export const SAME_ARTIST_INTROS = [
  "This next block is a same-artist set — all {artist}.",
  "Up next: a one-artist mini-set from {artist}.",
  "We're parking on one artist for this set: {artist}.",
  "Same-artist set coming up. It's all {artist} from here.",
  "Hold the lane — this is a {artist} set, start to finish.",
  "One name on the ticket this time: {artist}.",
  "I stacked a same-artist run. {artist} takes the whole block.",
  "Mini-set alert: nothing but {artist} for the next few.",
  "We're doing a deep dive — same artist, all {artist}.",
  "Clear the deck for a {artist} same-artist set.",
  "This one's a showcase set. {artist} only.",
  "Stay with me — it's a one-artist set by {artist}.",
  "I queued a same-artist stretch. {artist} owns this block.",
  "All eyes on one catalog: {artist}.",
  "Same-artist set locked in. {artist} for the next few tracks.",
  "Don't touch that dial — {artist} has the whole next set.",
  "I pulled a one-artist stack. {artist} start to finish.",
  "This is a {artist} showcase, not a mixed lane.",
  "Same name, same set: {artist} for the next few.",
  "We're staying home tonight — home is {artist}.",
  "One artist, no guests. {artist} takes it from here.",
  "I carved out a {artist} mini-set. Same artist all the way.",
  "Hold your drinks — this block is a {artist} same-artist set.",
  "The next few are a {artist} run. One catalog, no detours.",
  "Showcase mode: {artist} only, top to bottom.",
  "I left the other names in the crate. This set is {artist}.",
  "Same-artist energy incoming. {artist} owns the next stretch.",
  "We're locking the lane on {artist} for a one-artist set.",
  "Full {artist} block. Same artist, no hopscotch.",
  "This is the {artist} set — one voice for the next few songs.",
];

export const SAME_ARTIST_BLURBS = [
  "Say this is a same-artist set and name {artist} once.",
  "Call it a one-artist mini-set by {artist}, then point at the first song.",
  "Make it clear every track in this block is {artist}.",
  "Hit the same-artist beat once: we're staying with {artist}.",
  "Frame it as a showcase set for {artist}, not a mixed genre lane.",
  "Tell the room this is a {artist}-only run, then hand it to the opener.",
  "One clear line that this block is all {artist}, no other names.",
  "Call out the same-artist set, name {artist}, keep it short.",
  "Treat this as a mini-concert by {artist}, not a genre hop.",
  "Say we're parking on {artist} for a few songs.",
  "Open the middle by naming the same-artist set and {artist}.",
  "Keep the middle about {artist} owning the next few tracks.",
  "One-artist energy: {artist} start to finish, then the first song.",
  "Make the same-artist set obvious — name {artist} once, no song list.",
  "Showcase {artist} as the only artist in this set.",
  "Say we locked the lane on {artist} and nobody else is invited.",
  "Call it a {artist} deep dive, then name the first track only.",
  "Tell them the crate has one name in it: {artist}.",
  "One sentence that this is a {artist} showcase block.",
  "Make the one-artist rule plain: {artist} for the whole set.",
  "Say we're not hopping artists — this stretch is {artist}.",
  "Frame the next few as a {artist} residency, then the opener.",
  "Hit once that {artist} takes every song in this block.",
  "Call it a same-name set and put {artist} on the marquee.",
  "Keep it tight: same-artist set, {artist}, then the first song.",
  "Say the mix stays on {artist} until this block is done.",
  "Treat it like a {artist} encore run, not a genre sampler.",
  "One line that we pulled only {artist} for this refill.",
  "Name the same-artist set, name {artist}, then get out of the way.",
  "Make {artist} the only proper noun in the middle besides the opener.",
];

export const SAME_ARTIST_ALWAYS =
  'This is a SAME-ARTIST set — every song is one artist. Open the middle by calling it a "same-artist" or "one-artist" set and name that artist once. Do not name other artists. Do not mention discoveries, genre lanes, or mixed energy.';

export const SAME_ARTIST_NEVER =
  "Do not frame this as a mixed genre or mood lane set. Do not list songs. Do not invent a second artist.";

/**
 * @param {unknown} value
 * @returns {{ artist: string, key: string } | null}
 */
export function cleanSameArtistBatch(value) {
  if (!value || typeof value !== "object") return null;
  const artist = String(value.artist || "").trim();
  const key = String(value.key || "").trim();
  if (!artist && !key) return null;
  return { artist: artist || key, key: key || artist };
}

function pickLine(arr, salt, offset) {
  if (!Array.isArray(arr) || !arr.length) return "";
  const index = Math.abs((Number(salt) || 0) + offset) % arr.length;
  return String(arr[index] || "").trim();
}

/**
 * @param {{ artist?: string, salt?: number }} [opts]
 */
export function pickSameArtistAnnounceLines(opts = {}) {
  const artist = String(opts.artist || "").trim() || "this artist";
  const salt = Number.isFinite(opts.salt) ? Number(opts.salt) : 0;
  return {
    artist,
    intro: fillArtistTemplate(pickLine(SAME_ARTIST_INTROS, salt, 0), artist),
    blurb: fillArtistTemplate(pickLine(SAME_ARTIST_BLURBS, salt, 5), artist),
    descriptor: "same-artist",
  };
}
