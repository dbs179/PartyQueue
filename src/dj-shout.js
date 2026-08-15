// Mood Pulse / DJ shout-outs on searched song adds.

import { getDjVoiceSettings } from "./settings.js";
import {
  isDjVoiceReady,
  announceOnSonos,
  parkRampForShortAnnounce,
  abortParkedAnnounce,
  formatMusicPronunciationGuide,
  formatHostDjGuidance,
  generateDjSpeechFromPrompt,
} from "./dj-voice.js";
import {
  getGuestNotesList,
  getGuestProfile,
  birthdayShoutLabel,
} from "./guest-profiles.js";
import { writeRequestShoutTemplate } from "./party-recap.js";
import {
  queueWorkGeneration,
  queueWorkWasPreempted,
} from "./queue-preempt.js";
import {
  isFirstShoutTonight,
  shouldBirthdayShout,
  pickFreshNotes,
  getRecentScripts,
  rememberShout,
  reserveFirstShout,
  releaseFirstShoutReservation,
} from "./dj-night-memory.js";
import { dedicationOf } from "./queue-origin.js";
import { sanitizeDedication } from "./display-name.js";
import { spotifyTrackId } from "./sampler.js";
import { pickFlavorAnnounceLines } from "./dj-flavor-announce.js";

let searchAddCount = 0;

/** Reset the every-N search-add counter (host shout-out memory clear). */
export function resetSearchAddCount() {
  searchAddCount = 0;
}

/** Test helper: reset the every-N search-add counter. */
export function resetSearchAddCountForTests() {
  resetSearchAddCount();
}

/**
 * Whether this searched add should get a DJ shout (percent or every-N).
 * Call once per successful guest search add (not Closing Time).
 * @param {{ force?: boolean, requestedBy?: string|null, ready?: boolean|null }} [opts]
 *   force=true for empty-queue adds (always shout when enabled).
 *   First named request tonight always shouts when enabled (skips percent/every-N).
 *   ready= override for tests (defaults to isDjVoiceReady()).
 */
export function shouldShoutOnSearch({
  force = false,
  requestedBy = null,
  ready = null,
} = {}) {
  const s = getDjVoiceSettings();
  if (!s.djShoutEnabled) return false;
  if (!(ready ?? isDjVoiceReady())) return false;

  // Hold first-shout in memory (not persisted) so a second add cannot stack
  // another shout while TTS/insert runs. Commit happens after pads land;
  // a failed announce releases so this guest can still get the welcome.
  const reserveFirst = () => {
    if (requestedBy) reserveFirstShout(requestedBy);
  };

  if (force) {
    searchAddCount += 1;
    reserveFirst();
    return true;
  }

  // Everyone's first request of the night gets a shout; do not advance every-N.
  if (requestedBy && isFirstShoutTonight(requestedBy)) {
    reserveFirst();
    return true;
  }

  if (s.djShoutMode === "every") {
    const n = Math.max(1, Number(s.djShoutEveryN) || 5);
    searchAddCount += 1;
    return searchAddCount % n === 0;
  }

  const pct = Math.max(0, Math.min(100, Number(s.djShoutPercent) || 0));
  if (pct <= 0) return false;
  if (pct >= 100) return true;
  return Math.random() * 100 < pct;
}

const NOTE_STOP = new Set([
  "mark",
  "dave",
  "maria",
  "jen",
  "likes",
  "like",
  "love",
  "loves",
  "named",
  "name",
  "birthday",
  "bday",
  "july",
  "june",
  "august",
  "with",
  "that",
  "this",
  "from",
  "have",
  "been",
  "about",
  "always",
  "really",
  "their",
  "there",
  "they",
  "them",
  "your",
  "youre",
  "just",
  "when",
  "what",
  "will",
  "would",
  "could",
  "should",
  "into",
  "onto",
  "over",
  "under",
  "also",
  "too",
  "very",
  "much",
  "more",
  "most",
  "some",
  "such",
  "than",
  "then",
  "them",
  "known",
  "alter",
  "ego",
  "each",
  "other",
  "make",
  "makes",
  "song",
  "songs",
]);

function isBirthdayNote(note) {
  return /birthday|bday|b-day/i.test(String(note || ""));
}

/** Pick 1–2 non-birthday notes the DJ must hit closely (prefer unused tonight). */
function pickBlurbNotes(requestedBy, limit = 2) {
  const all = getGuestNotesList(requestedBy).filter((n) => !isBirthdayNote(n));
  if (!all.length) {
    // Fall back to any notes (including birthday text) if that's all we have.
    return pickFreshNotes(requestedBy, getGuestNotesList(requestedBy), limit);
  }
  return pickFreshNotes(requestedBy, all, limit);
}

function distinctiveTokens(note, guestName = "") {
  const nameBits = String(guestName || "")
    .toLowerCase()
    .match(/[a-z0-9']+/g) || [];
  const stop = new Set([...NOTE_STOP, ...nameBits]);
  return (String(note || "").toLowerCase().match(/[a-z0-9']+/g) || []).filter(
    (w) => w.length >= 4 && !stop.has(w)
  );
}

/** True if the spoken line clearly reflects this settings note. */
export function scriptCoversNote(script, note, guestName = "") {
  const tokens = distinctiveTokens(note, guestName);
  if (!tokens.length) return true;
  const s = String(script || "").toLowerCase();
  // Prefer the most distinctive token (longest), require at least one hit.
  const ranked = [...tokens].sort((a, b) => b.length - a.length);
  return ranked.slice(0, 3).some((t) => s.includes(t));
}

function notesMissingFromScript(script, notes, guestName) {
  return (Array.isArray(notes) ? notes : []).filter(
    (n) => !scriptCoversNote(script, n, guestName)
  );
}

function buildRequestShoutPrompt({
  name,
  artist,
  requestedBy,
  dedication = null,
  notes,
  isBirthday,
  birthdayLabel,
  djName,
  maxWords,
  banList,
  djSettings = null,
  priorScripts = [],
  stricter = false,
  kind = "songRequest",
  flavorIntro = "",
  flavorBlurb = "",
  trackCount = 0,
}) {
  const song = String(name || "this next track").trim();
  const who = String(artist || "").trim();
  const by = String(requestedBy || "").trim() || "a guest";
  const forWho = String(dedication || "").trim();
  const dj = String(djName || "DJ").trim() || "DJ";
  const list = Array.isArray(notes) ? notes.filter(Boolean) : [];
  const noteLines = list.map((n, i) => `${i + 1}. ${n}`).join("\n");
  const ban =
    typeof banList === "string" && banList.trim()
      ? `\nNever say: ${banList.trim()}.`
      : "";

  const count = list.length;
  const blurbRule =
    count === 0
      ? `- No host blurbs on file — skip personality bits.`
      : count === 1
        ? `- REQUIRED: use blurb #1 closely. Keep its key words (e.g. names, nouns like crayons, Gypsy). Light polish for speech is OK; do NOT replace it with a vague paraphrase that drops those words.`
        : `- REQUIRED: use BOTH blurb #1 AND blurb #2. Each must be clearly hearable — keep the important words from settings (nouns/names). Do not drop either blurb. Do not invent different facts.`;

  const bdayRule = isBirthday
    ? `- REQUIRED: it is ${by}'s birthday today. Wish them happy birthday and call them the ${birthdayLabel}.`
    : `- It is NOT their birthday — do not invent a birthday.`;

  const dedRule = forWho
    ? `- REQUIRED: say this request goes out to ${forWho} (dedication). Keep it natural — e.g. "this one goes out to ${forWho}".`
    : `- No dedication — do not invent a dedicatee.`;

  const setKind = kind === "setRequest";
  const kindRule = setKind
    ? `- REQUIRED: this is a SET REQUEST from ${by} — several songs by ${who || "one artist"}, not a single-song request. Say "Set Request" or "mini-set". Do not treat it as one track.`
    : `- REQUIRED: this is a single SONG REQUEST from ${by}, not a Set Request and not a Random fill. Say it is a request.`;
  const flavorRule = flavorBlurb
    ? `- REQUIRED beat (say it once, naturally): ${flavorBlurb}`
    : "";
  const introHint = flavorIntro
    ? `- Scripted flavor (you may echo the idea, do not copy word-for-word unless it fits): ${flavorIntro}`
    : "";

  const priors = (Array.isArray(priorScripts) ? priorScripts : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  const avoidRule = priors.length
    ? `- Already said earlier tonight — do not reuse the same jokes, phrases, or wording:\n${priors
        .map((s, i) => `  ${i + 1}. ${s}`)
        .join("\n")}`
    : "";

  const strictExtra = stricter
    ? `\nRETRY: Your previous draft skipped required blurb words. Say the blurbs more literally — listeners should hear the same jokes as written in settings.`
    : "";

  const hostGuidance = formatHostDjGuidance({
    personaNotes: djSettings?.djPersonaNotes,
    alwaysInstructions: djSettings?.djAlwaysInstructions,
    neverInstructions: djSettings?.djNeverInstructions,
  });

  return `You are ${dj}, a lively party DJ on Sonos. Write ONE short spoken shout-out only (no quotes, no stage directions, no bullet lists).

${hostGuidance ? `${hostGuidance}\n\n` : ""}${formatMusicPronunciationGuide(
    djSettings?.djPronunciations
  )}

Hard limits:
- At most ${maxWords} words
- Warm party-DJ energy, but stay faithful to the host blurbs
- Do NOT read them as "blurb one, blurb two"
- Do NOT swap in unrelated jokes
${blurbRule}
${bdayRule}
${dedRule}
${kindRule}
${flavorRule}
${introHint}
${avoidRule}${ban}${strictExtra}

Facts:
- Shout kind: ${setKind ? "SET REQUEST (mini-set, several songs)" : "SONG REQUEST (one track)"}
- Requester display name: ${by}
- Dedication (goes out to): ${forWho || "(none)"}
- ${setKind ? "First song in the set" : "Song title"}: ${song}
- Artist: ${who || "(unknown)"}
- Set track count: ${setKind ? trackCount || "a few" : "1"}
- Birthday today: ${isBirthday ? `YES — ${birthdayLabel}` : "no"}

Host blurbs (use these closely — they are the jokes):
${noteLines || "(no blurbs)"}

Must include:
1) shout-out to ${by}
2) ${isBirthday ? `happy birthday + "${birthdayLabel}"` : "no birthday line"}
3) ${forWho ? `dedication line for ${forWho}` : "no dedication line"}
4) ${setKind ? `Set Request / mini-set by ${who || "the artist"}, then the first song` : "the song (and artist if known)"}
5) ${count ? `all ${count} blurb(s) above, close to the original wording` : "no blurb"}
6) ${setKind ? 'the words "Set Request" or "mini-set"' : "that this is a song request, not a set"}

Write only the spoken announcement now.`;
}

function shoutDraft(line, { by, notes, isBirthday }) {
  return {
    script: String(line || "").trim(),
    requestedBy: by,
    notes,
    isBirthday: !!isBirthday,
  };
}

/** Drop a pending first-shout when the announce never starts. */
export function releaseReservedFirstShout(requestedBy) {
  return releaseFirstShoutReservation(requestedBy);
}

/**
 * AI shout script from host notes; falls back to templates if LLM fails.
 * Does not persist first-shout / notes / birthday — announceRequestShout
 * commits after the pads land.
 * @returns {Promise<{ script: string, requestedBy: string, notes: string[], isBirthday: boolean }>}
 */
export async function writeRequestShoutScript({
  name,
  artist,
  requestedBy,
  dedication = null,
  trackId = null,
  kind = "songRequest",
  trackCount = 0,
} = {}) {
  const dj = getDjVoiceSettings();
  const by = String(requestedBy || "").trim();
  const shoutKind = kind === "setRequest" ? "setRequest" : "songRequest";
  const flavor = pickFlavorAnnounceLines(shoutKind, {
    guest: by || "a guest",
    artist,
    song: name,
    count: trackCount,
    salt:
      (by.length * 13 +
        String(artist || "").length +
        String(name || "").length +
        Number(trackCount || 0)) %
      97,
  });
  const profile = by ? getGuestProfile(by) : null;
  // Prefer live origin dedication (toast may land while TTS is generating).
  const forWho =
    sanitizeDedication(dedication) ||
    (trackId ? dedicationOf(trackId) : null) ||
    null;
  // Exactly 1–2 blurbs so the model can't cherry-pick one and ignore others.
  const notes = by ? pickBlurbNotes(by, 2) : [];
  const isBirthday = by ? shouldBirthdayShout(by) : false;
  const birthdayLabel = by ? birthdayShoutLabel(by) : "birthday star";
  const priorScripts = by ? getRecentScripts(by, 3) : [];
  const maxWords = Math.min(
    shoutKind === "setRequest" || isBirthday || notes.length || forWho
      ? 75
      : 45,
    Math.max(32, (Number(dj.djAnnounceMaxWords) || 55) + 15)
  );

  const promptArgs = {
    name,
    artist,
    requestedBy: by,
    dedication: forWho,
    notes,
    isBirthday,
    birthdayLabel,
    djName: dj.djName,
    maxWords,
    banList: dj.djBanList,
    djSettings: dj,
    priorScripts,
    kind: shoutKind,
    flavorIntro: flavor?.intro || "",
    flavorBlurb: flavor?.blurb || "",
    trackCount,
  };

  // Unique Set Request / song-request templates already name the kind.
  // Only call the LLM when there is extra guest fuel to weave in.
  if (notes.length || isBirthday || forWho) {
    try {
      let line = await generateDjSpeechFromPrompt(
        buildRequestShoutPrompt(promptArgs),
        { maxWords, banList: dj.djBanList }
      );

      let missing = notesMissingFromScript(line, notes, by);
      if (missing.length) {
        console.warn(
          `[dj-shout] script missed blurb words (${missing.join(" | ")}) — retrying stricter`
        );
        line = await generateDjSpeechFromPrompt(
          buildRequestShoutPrompt({
            ...promptArgs,
            stricter: true,
          }),
          { maxWords, banList: dj.djBanList }
        );
        missing = notesMissingFromScript(line, notes, by);
      }

      // Last resort: stitch any still-missing blurbs on almost literally.
      if (missing.length) {
        const stitch = missing
          .map((n) => (n.endsWith(".") ? n : `${n}.`))
          .join(" ");
        line = `${line.replace(/[.!?]*\s*$/, "")}. ${stitch}`;
        console.warn(`[dj-shout] stitched missing blurbs onto script`);
      }

      console.log(
        `[dj-shout] script via OpenAI (kind=${shoutKind}, blurbs=${notes.length}, birthday=${isBirthday}, dedication=${forWho || "none"}, profile=${profile?.name || "none"})`
      );
      console.log(`[dj-shout] blurb fuel: ${notes.join(" | ") || "(none)"}`);
      return shoutDraft(line, { by, notes, isBirthday });
    } catch (err) {
      console.error(
        "[dj-shout] LLM shout failed, using template:",
        err.message
      );
    }
  } else if (by) {
    console.log(
      `[dj-shout] no notes/birthday on file for "${by}" — template only`
    );
  }

  return shoutDraft(
    writeRequestShoutTemplate({
      name,
      artist,
      requestedBy,
      dedication: forWho,
      isBirthday,
      birthdayLabel,
      notes,
      kind: shoutKind,
      trackCount,
      flavorIntro: flavor?.intro || "",
    }),
    { by, notes, isBirthday }
  );
}

/**
 * Insert a shout TTS immediately before the newly queued song.
 * Empty-queue adds should pass startPlayback: true so Sonos plays the shout
 * first. Callers hold/pause transport while TTS builds so the song does not
 * audibly start before the DJ pads.
 * @returns {Promise<{ok: boolean, skipped?: boolean, error?: string}>}
 */
export async function announceRequestShout(
  {
    name,
    artist,
    requestedBy,
    dedication = null,
    uri = null,
    trackId = null,
    kind = "songRequest",
    trackCount = 0,
    queuePosition,
    startPlayback = false,
    preemptGeneration = queueWorkGeneration(),
  } = {}
) {
  const by = String(requestedBy || "").trim();
  let committed = false;
  // A park freezes Never-Ending and can hold the room on silence, so it must
  // be unwound on every exit — including a thrown script/TTS error.
  let parked = null;
  let parkResolved = false;
  try {
    if (!isDjVoiceReady()) {
      return { ok: false, skipped: true };
    }
    let pos = Number(queuePosition);
    if (!Number.isFinite(pos) || pos < 1) {
      return { ok: false, skipped: true, error: "Missing queue position." };
    }
    // Park on the volume ramp BEFORE script/TTS when the current song will
    // end first — otherwise the request teases, then the insert steals the
    // playhead and restarts it after the DJ.
    if (!startPlayback) {
      try {
        parked = await parkRampForShortAnnounce({
          queuePosition: pos,
          requestUri: uri,
          preemptGeneration,
        });
        if (parked?.requestPos) pos = Number(parked.requestPos);
        else if (parked?.rampPos) pos = Number(parked.rampPos) + 1;
      } catch (err) {
        console.warn("[dj-shout] ramp park skipped:", err.message);
        parked = null;
      }
    }
    const id = trackId || spotifyTrackId(uri) || null;
    // Re-read dedication at script time (toast dedicate may have landed).
    const draft = await writeRequestShoutScript({
      name,
      artist,
      requestedBy,
      dedication,
      trackId: id,
      kind,
      trackCount,
    });
    const message = draft?.script || "";
    if (!message) {
      return { ok: false, skipped: true, error: "Empty shout script." };
    }
    if (queueWorkWasPreempted(preemptGeneration)) {
      return { ok: false, skipped: true, reason: "queue-preempted" };
    }
    // Script/TTS can take several seconds — re-find the song so the shout still
    // lands immediately before it (not after, if the queue shifted).
    if (!startPlayback && !parked) {
      try {
        const { findUpcomingTrackPosition } = await import("./sonos.js");
        const live = await findUpcomingTrackPosition({
          name,
          artist,
          uri,
          expected: pos,
        });
        if (live != null && live !== pos) {
          console.log(
            `[dj-shout] shout insert catch-up: planned #${pos} → #${live} (live song position)`
          );
          pos = live;
        }
      } catch (err) {
        console.warn("[dj-shout] live position read failed:", err.message);
      }
    }
    console.log(
      `[dj-shout] ${startPlayback ? "empty/idle start · " : ""}${message}`
    );
    const result = await announceOnSonos(message, {
      startPlayback: !!startPlayback,
      queuePosition: pos,
      preemptGeneration,
      // Re-resolve the request under the insert lock after TTS so pads stay
      // glued to it if the queue shifted during script generation.
      applyLeadBuffer: !startPlayback && !parked,
      requestUri: uri || null,
      allowImminentPause: false,
      // Without a park, next-up still holds at the tail of the current song so
      // the request cannot start before the pads land.
      holdAtTrackEnd:
        !startPlayback && !parked && Number(queuePosition) === 1,
      parked,
    });
    if (parked) {
      if (!(result?.ok || result?.inserted)) {
        await abortParkedAnnounce(parked, "shout insert failed");
      }
      parkResolved = true;
    }
    // Commit once the announce block is in the queue (or Play succeeded).
    // A failed/preempted insert releases so this guest can still get first-shout.
    if (by && (result?.ok || result?.inserted)) {
      rememberShout({
        name: by,
        notes: draft.notes,
        script: message,
        birthday: !!draft.isBirthday,
      });
      committed = true;
    }
    return result;
  } finally {
    if (parked && !parkResolved) {
      await abortParkedAnnounce(parked, "shout aborted before insert").catch(
        (err) =>
          console.error("[dj-shout] park unwind failed:", err?.message || err)
      );
    }
    if (!committed && by) releaseFirstShoutReservation(by);
  }
}

/**
 * Queue a mid-party shout onto the announce lock. Next-up / empty-queue
 * callers should await so pads land before the HTTP response. Further-back
 * adds return immediately so several songs in a row each lock in a shout
 * without blocking the next append.
 */
export function queueRequestShout(opts, { awaitInsert = false } = {}) {
  const run = announceRequestShout(opts);
  if (awaitInsert) return run;
  void run.catch((err) =>
    console.error("[queue] request shout:", err.message)
  );
  return Promise.resolve({ ok: true, queued: true });
}
