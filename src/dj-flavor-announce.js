/**
 * Unique DJ announce banks for guest requests and Never-Ending rotations.
 * Same pattern as same-artist: 30 scripted intros + 30 LLM blurbs each.
 */

/** @param {string} text @param {Record<string, string>} tokens */
export function fillFlavorTokens(text, tokens = {}) {
  return String(text || "").replace(/\{(\w+)\}/g, (_, key) => {
    const value = tokens[key];
    return value != null && String(value).trim() ? String(value).trim() : `{${key}}`;
  });
}

function pickLine(arr, salt, offset) {
  if (!Array.isArray(arr) || !arr.length) return "";
  const index = Math.abs((Number(salt) || 0) + offset) % arr.length;
  return String(arr[index] || "").trim();
}

export const SET_REQUEST_INTROS = [
  "Set Request from {guest} — a {artist} mini-set.",
  "{guest} just dropped a Set Request. All {artist}.",
  "Incoming Set Request: {guest} wants a {artist} block.",
  "That's a Set Request, not a one-off. {guest} picked {artist}.",
  "{guest} ordered a whole {artist} Set Request.",
  "Set Request locked in. {guest} put {artist} on the ticket.",
  "Hold up — {guest} sent a Set Request. {artist} for a few.",
  "{guest} didn't pick one song. This is a {artist} Set Request.",
  "Set Request from {guest}. We're staying with {artist}.",
  "{guest} called a {artist} Set Request. Here it comes.",
  "That's a full Set Request from {guest} — {artist} only.",
  "{guest} just stacked a {artist} Set Request.",
  "Set Request alert: {guest} wants {artist} start to finish.",
  "{guest} put in a Set Request. Mini-set by {artist}.",
  "We got a Set Request. {guest} chose {artist}.",
  "{guest} is running a {artist} Set Request.",
  "Not a single — a Set Request from {guest}. {artist} time.",
  "{guest} requested a {artist} Set Request, not just a track.",
  "Set Request incoming from {guest}. All {artist}.",
  "{guest} said give me a {artist} Set Request. We heard it.",
  "That's {guest} with a Set Request — {artist} for the next few.",
  "{guest} dropped a Set Request. {artist} takes the block.",
  "Set Request from {guest}. One artist: {artist}.",
  "{guest} just booked a {artist} Set Request.",
  "A whole Set Request, not a single. {guest} picked {artist}.",
  "{guest} sent a Set Request. We're parking on {artist}.",
  "Set Request from {guest} — {count} songs of {artist}.",
  "{guest} wants a {artist} run. Set Request granted.",
  "Here comes a Set Request. {guest} put {artist} in charge.",
  "{guest} called it: Set Request, {artist} only.",
];

export const SET_REQUEST_BLURBS = [
  "Say this is a Set Request from {guest} and name {artist} once.",
  "Call it a Set Request mini-set by {artist}, requested by {guest}.",
  "Make it clear {guest} asked for a whole {artist} set, not one song.",
  "Hit the Set Request beat: {guest} stacked {artist}.",
  "Frame it as {guest}'s Set Request — several {artist} tracks.",
  "Tell the room {guest} ordered a {artist} block.",
  "One line that this is a Set Request from {guest} for {artist}.",
  "Call out Set Request, {guest}, and {artist}. Keep it short.",
  "Treat this as {guest}'s {artist} set, not a Random refill.",
  "Say {guest} requested a {artist} set and we're playing it.",
  "Open by naming the Set Request and {guest}, then {artist}.",
  "Keep the middle about {guest}'s Set Request for {artist}.",
  "Set Request energy: {guest} wants {artist} for a few songs.",
  "Make the Set Request obvious — {guest}, {artist}, no song list.",
  "Showcase {artist} as {guest}'s Set Request.",
  "Say {guest} didn't pick one track — they picked a {artist} set.",
  "Call it {guest}'s {artist} Set Request, then the first song.",
  "Tell them the next few are {guest}'s {artist} Set Request.",
  "One sentence: Set Request from {guest}, all {artist}.",
  "Make the set-not-single rule plain: {guest} asked for {artist}.",
  "Say we're running {guest}'s Set Request for {artist}.",
  "Frame the block as a {artist} Set Request from {guest}.",
  "Hit once that {guest} booked {artist} for a set.",
  "Call it a Set Request and put {guest} and {artist} on it.",
  "Keep it tight: Set Request, {guest}, {artist}, first song.",
  "Say the queue is honoring {guest}'s {artist} Set Request.",
  "Treat it like {guest} hired {artist} for a mini-set.",
  "One line that {guest} dropped a {artist} Set Request.",
  "Name Set Request, name {guest}, name {artist}, then the opener.",
  "Make {guest} and {artist} the only names besides the first song.",
];

export const SONG_REQUEST_INTROS = [
  "Song request from {guest}: {song} by {artist}.",
  "{guest} just requested {song}.",
  "One-song request incoming — {guest} picked {song} by {artist}.",
  "{guest} put a request in the queue: {song}.",
  "That's a single request from {guest}. {artist} — {song}.",
  "Request from {guest}. We're spinning {song}.",
  "{guest} called in a request for {song} by {artist}.",
  "Guest request: {guest} wants {song}.",
  "{guest} just scored a request. {song} is up.",
  "One track, one request. {guest} chose {song} by {artist}.",
  "Song request locked — {guest} asked for {song}.",
  "{guest} dropped a request. Here comes {song}.",
  "That's {guest} with a song request: {song} by {artist}.",
  "{guest} requested {song}. We got it.",
  "Single request from {guest} — {song} by {artist}.",
  "{guest} put {song} in. Request granted.",
  "A request, not a Random pick. {guest} wanted {song}.",
  "{guest} just punched in a request: {song} by {artist}.",
  "Song request from {guest}. {song} by {artist} coming up.",
  "{guest} requested this one: {song}.",
  "Hold the Random — {guest} requested {song}.",
  "{guest} sent a song request. {artist} — {song}.",
  "That's a guest request from {guest}. {song} next.",
  "{guest} requested {song} by {artist}. Coming right up.",
  "Request in: {guest} picked {song}.",
  "{guest} just added a request. {song} by {artist}.",
  "One song request for {guest}: {song}.",
  "{guest} called in a request — {song} by {artist}.",
  "Song request from {guest}. We heard you — {song}.",
  "{guest} requested this one. {song} is next.",
];

export const SONG_REQUEST_BLURBS = [
  "Say this is a song request from {guest} and name {song}.",
  "Call it a single request from {guest}, then {song} by {artist}.",
  "Make it clear {guest} requested this one song, not a set.",
  "Hit the request beat: {guest} asked for {song}.",
  "Frame it as {guest}'s song request — {artist}, {song}.",
  "Tell the room {guest} put {song} in the queue.",
  "One line that this is a request from {guest} for {song}.",
  "Call out song request, {guest}, and {song}. Keep it short.",
  "Treat this as {guest}'s request, not a Random fill.",
  "Say {guest} requested {song} and we're playing it.",
  "Open by naming the request and {guest}, then {song}.",
  "Keep the middle about {guest}'s request for {song}.",
  "Request energy: {guest} wanted {song} by {artist}.",
  "Make the song request obvious — {guest}, {song}, no set talk.",
  "Name {guest} and {song} as a one-track request.",
  "Say {guest} picked one song: {song}.",
  "Call it {guest}'s request, then {song} by {artist}.",
  "Tell them this next one is {guest}'s request.",
  "One sentence: song request from {guest}, {song}.",
  "Make the single-request rule plain: {guest} asked for {song}.",
  "Say we're playing {guest}'s request — {song}.",
  "Frame the track as a request from {guest}, not filler.",
  "Hit once that {guest} requested {song} by {artist}.",
  "Call it a song request and put {guest} on it.",
  "Keep it tight: request, {guest}, {song}.",
  "Say the queue is honoring {guest}'s request for {song}.",
  "Treat it like {guest} walked up and asked for {song}.",
  "One line that {guest} dropped a request for {song}.",
  "Name the request, name {guest}, name {song}.",
  "Make {guest} and {song} the headline of this shout.",
];

export const ROTATE_MOOD_INTROS = [
  "We just rotated the mood. This set is {mood}.",
  "New vibe lock: {mood}.",
  "Mood wheel landed on {mood}.",
  "Fresh mood for this set — {mood}.",
  "We flipped the mood. Welcome to {mood}.",
  "Rotation hit. This block is {mood}.",
  "New mood, new set: {mood}.",
  "The mood just changed. We're on {mood}.",
  "Mood rotate — {mood} takes this set.",
  "We spun the mood. {mood} is up.",
  "Different energy now. This set is {mood}.",
  "Mood switch. {mood} from here.",
  "The booth rotated to {mood}.",
  "New mood incoming: {mood}.",
  "We changed the mix. {mood} set.",
  "Mood rotation complete. {mood} time.",
  "Hold on — the mood just flipped to {mood}.",
  "This set rides the {mood} mood.",
  "We rotated off the last vibe. {mood} now.",
  "Mood picker says {mood}. Let's go.",
  "A new mood just locked in: {mood}.",
  "Rotation: {mood} for the next few.",
  "We turned the mood dial to {mood}.",
  "Fresh {mood} set after the rotate.",
  "The night just shifted to {mood}.",
  "Mood change. {mood} owns this block.",
  "We rotated. This one's {mood}.",
  "New direction: {mood}.",
  "The mood wheel gave us {mood}.",
  "Set flavor just became {mood}.",
];

export const ROTATE_MOOD_BLURBS = [
  "Say we just rotated the mood and this set is {mood}.",
  "Call out the mood change to {mood}, then the first song.",
  "Make it clear the vibe rotated to {mood}.",
  "Hit the rotation beat once: new mood, {mood}.",
  "Frame this as a {mood} set after a mood rotate.",
  "Tell the room the mood wheel landed on {mood}.",
  "One line that we flipped the mood to {mood}.",
  "Call out mood rotation and {mood}. Keep it short.",
  "Treat this as a fresh {mood} set, not the last vibe.",
  "Say the booth rotated to {mood} for this block.",
  "Open by naming the mood rotate and {mood}.",
  "Keep the middle about the new {mood} mood.",
  "Mood-rotate energy: this set is {mood}.",
  "Make the mood change obvious — we are on {mood} now.",
  "Name {mood} as the new rotated mood.",
  "Say we changed the mix and {mood} is in charge.",
  "Call it a {mood} rotation, then the opener.",
  "Tell them this block follows a rotate to {mood}.",
  "One sentence: mood rotated, this set is {mood}.",
  "Make the rotate plain: new mood is {mood}.",
  "Say we're running a {mood} set after the rotate.",
  "Frame the block as a {mood} mood rotation.",
  "Hit once that the mood just became {mood}.",
  "Call it a mood rotate and put {mood} on the marquee.",
  "Keep it tight: rotated to {mood}, then the first song.",
  "Say the night shifted to {mood} for this set.",
  "Treat it like the booth spun {mood} on purpose.",
  "One line that we rotated into a {mood} set.",
  "Name the mood rotate, name {mood}, then the opener.",
  "Make {mood} the only mood word in the middle.",
];

export const ROTATE_DECADE_INTROS = [
  "Decade wheel just landed on the {decade}.",
  "We're time-traveling — {decade} set.",
  "New decade lock: the {decade}.",
  "We rotated the era. This set is {decade}.",
  "The decade just flipped to the {decade}.",
  "Era rotate. Welcome to the {decade}.",
  "Fresh decade for this set — {decade}.",
  "We spun the years. {decade} is up.",
  "Decade change. The {decade} take this block.",
  "Time jump: {decade} from here.",
  "The booth rotated to the {decade}.",
  "New era incoming: {decade}.",
  "We changed the decade. {decade} set.",
  "Decade rotation complete. {decade} time.",
  "Hold on — we just jumped to the {decade}.",
  "This set lives in the {decade}.",
  "We rotated off the last era. {decade} now.",
  "Decade picker says {decade}. Let's go.",
  "A new decade just locked in: {decade}.",
  "Rotation: {decade} for the next few.",
  "We turned the year dial to the {decade}.",
  "Fresh {decade} set after the rotate.",
  "The night just shifted to the {decade}.",
  "Decade change. {decade} owns this block.",
  "We rotated. This one's the {decade}.",
  "New direction: the {decade}.",
  "The decade wheel gave us the {decade}.",
  "Set flavor just became {decade}.",
  "We're parking in the {decade} for this set.",
  "Era switch. All {decade} from here.",
];

export const ROTATE_DECADE_BLURBS = [
  "Say we just rotated the decade and this set is the {decade}.",
  "Call out the era change to the {decade}, then the first song.",
  "Make it clear we time-jumped to the {decade}.",
  "Hit the rotation beat once: new decade, {decade}.",
  "Frame this as a {decade} set after a decade rotate.",
  "Tell the room the decade wheel landed on the {decade}.",
  "One line that we flipped the era to the {decade}.",
  "Call out decade rotation and {decade}. Keep it short.",
  "Treat this as a fresh {decade} set, not the last era.",
  "Say the booth rotated to the {decade} for this block.",
  "Open by naming the decade rotate and {decade}.",
  "Keep the middle about the new {decade} era.",
  "Decade-rotate energy: this set is {decade}.",
  "Make the era change obvious — we are in the {decade} now.",
  "Name the {decade} as the new rotated decade.",
  "Say we changed the years and the {decade} are in charge.",
  "Call it a {decade} rotation, then the opener.",
  "Tell them this block follows a rotate to the {decade}.",
  "One sentence: decade rotated, this set is {decade}.",
  "Make the rotate plain: new decade is the {decade}.",
  "Say we're running a {decade} set after the rotate.",
  "Frame the block as a {decade} decade rotation.",
  "Hit once that the era just became the {decade}.",
  "Call it a decade rotate and put {decade} on the marquee.",
  "Keep it tight: rotated to the {decade}, then the first song.",
  "Say the night shifted to the {decade} for this set.",
  "Treat it like the booth spun the {decade} on purpose.",
  "One line that we rotated into a {decade} set.",
  "Name the decade rotate, name {decade}, then the opener.",
  "Make {decade} the only era word in the middle.",
];

/**
 * @param {"setRequest"|"songRequest"|"rotateMood"|"rotateDecade"} kind
 * @param {{ salt?: number, guest?: string, artist?: string, song?: string, count?: string|number, mood?: string, decade?: string }} [opts]
 */
export function pickFlavorAnnounceLines(kind, opts = {}) {
  const salt = Number.isFinite(opts.salt) ? Number(opts.salt) : 0;
  const tokens = {
    guest: String(opts.guest || "a guest").trim() || "a guest",
    artist: String(opts.artist || "this artist").trim() || "this artist",
    song: String(opts.song || "this next track").trim() || "this next track",
    count: String(opts.count || "").trim() || "a few",
    mood: String(opts.mood || "a new mood").trim() || "a new mood",
    decade: String(opts.decade || "a new decade").trim() || "a new decade",
  };
  let intros = [];
  let blurbs = [];
  let descriptor = "hand-picked";
  if (kind === "setRequest") {
    intros = SET_REQUEST_INTROS;
    blurbs = SET_REQUEST_BLURBS;
    descriptor = "set-request";
  } else if (kind === "songRequest") {
    intros = SONG_REQUEST_INTROS;
    blurbs = SONG_REQUEST_BLURBS;
    descriptor = "song-request";
  } else if (kind === "rotateMood") {
    intros = ROTATE_MOOD_INTROS;
    blurbs = ROTATE_MOOD_BLURBS;
    descriptor = "mood-rotate";
  } else if (kind === "rotateDecade") {
    intros = ROTATE_DECADE_INTROS;
    blurbs = ROTATE_DECADE_BLURBS;
    descriptor = "decade-rotate";
  } else {
    return null;
  }
  return {
    kind,
    intro: fillFlavorTokens(pickLine(intros, salt, 0), tokens),
    blurb: fillFlavorTokens(pickLine(blurbs, salt, 7), tokens),
    descriptor,
  };
}

/**
 * @param {unknown} value
 * @returns {{ mood: string|null, decade: string|null } | null}
 */
export function cleanRotationFlavor(value) {
  if (!value || typeof value !== "object") return null;
  const mood = String(value.mood || "").trim();
  const decade = String(value.decade || "").trim();
  if (!mood && !decade) return null;
  return { mood: mood || null, decade: decade || null };
}
