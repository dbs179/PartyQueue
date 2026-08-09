// Mood Pulse / DJ shout-outs on searched song adds.

import { getDjVoiceSettings } from "./settings.js";
import {
  isDjVoiceReady,
  announceOnSonos,
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
} from "./dj-night-memory.js";
import { dedicationOf } from "./queue-origin.js";
import { sanitizeDedication } from "./display-name.js";
import { spotifyTrackId } from "./sampler.js";

let searchAddCount = 0;

/** Test helper: reset the every-N search-add counter. */
export function resetSearchAddCountForTests() {
  searchAddCount = 0;
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

  // Reserve first-shout synchronously when we decide to shout. Script/TTS can
  // take many seconds; without this, a second concurrent add still sees
  // isFirstShoutTonight and stacks another shout (two ramp+TTS back-to-back).
  const reserveFirst = () => {
    if (requestedBy && isFirstShoutTonight(requestedBy)) {
      rememberShout({ name: requestedBy });
    }
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
${avoidRule}${ban}${strictExtra}

Facts:
- Requester display name: ${by}
- Dedication (goes out to): ${forWho || "(none)"}
- Song title: ${song}
- Artist: ${who || "(unknown)"}
- Birthday today: ${isBirthday ? `YES — ${birthdayLabel}` : "no"}

Host blurbs (use these closely — they are the jokes):
${noteLines || "(no blurbs)"}

Must include:
1) shout-out to ${by}
2) ${isBirthday ? `happy birthday + "${birthdayLabel}"` : "no birthday line"}
3) ${forWho ? `dedication line for ${forWho}` : "no dedication line"}
4) the song (and artist if known)
5) ${count ? `all ${count} blurb(s) above, close to the original wording` : "no blurb"}

Write only the spoken announcement now.`;
}

function rememberAndReturn(line, { by, notes, isBirthday }) {
  const script = String(line || "").trim();
  if (by && script) {
    rememberShout({
      name: by,
      notes,
      script,
      birthday: !!isBirthday,
    });
  }
  return script;
}

/**
 * AI shout script from host notes; falls back to templates if LLM fails.
 */
export async function writeRequestShoutScript({
  name,
  artist,
  requestedBy,
  dedication = null,
  trackId = null,
} = {}) {
  const dj = getDjVoiceSettings();
  const by = String(requestedBy || "").trim();
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
    isBirthday || notes.length || forWho ? 70 : 45,
    Math.max(32, (Number(dj.djAnnounceMaxWords) || 55) + 10)
  );

  if (notes.length || isBirthday || forWho) {
    try {
      let line = await generateDjSpeechFromPrompt(
        buildRequestShoutPrompt({
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
        }),
        { maxWords, banList: dj.djBanList }
      );

      let missing = notesMissingFromScript(line, notes, by);
      if (missing.length) {
        console.warn(
          `[dj-shout] script missed blurb words (${missing.join(" | ")}) — retrying stricter`
        );
        line = await generateDjSpeechFromPrompt(
          buildRequestShoutPrompt({
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
        `[dj-shout] script via OpenAI (blurbs=${notes.length}, birthday=${isBirthday}, dedication=${forWho || "none"}, profile=${profile?.name || "none"})`
      );
      console.log(`[dj-shout] blurb fuel: ${notes.join(" | ") || "(none)"}`);
      return rememberAndReturn(line, { by, notes, isBirthday });
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

  return rememberAndReturn(
    writeRequestShoutTemplate({
      name,
      artist,
      requestedBy,
      dedication: forWho,
      isBirthday,
      birthdayLabel,
      notes,
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
    queuePosition,
    startPlayback = false,
    preemptGeneration = queueWorkGeneration(),
  } = {}
) {
  if (!isDjVoiceReady()) {
    return { ok: false, skipped: true };
  }
  let pos = Number(queuePosition);
  if (!Number.isFinite(pos) || pos < 1) {
    return { ok: false, skipped: true, error: "Missing queue position." };
  }
  const id = trackId || spotifyTrackId(uri) || null;
  // Re-read dedication at script time (toast dedicate may have landed).
  const message = await writeRequestShoutScript({
    name,
    artist,
    requestedBy,
    dedication,
    trackId: id,
  });
  if (queueWorkWasPreempted(preemptGeneration)) {
    return { ok: false, skipped: true, reason: "queue-preempted" };
  }
  // Script/TTS can take several seconds — re-find the song so the shout still
  // lands immediately before it (not after, if the queue shifted).
  if (!startPlayback) {
    try {
      const { findUpcomingTrackPosition } = await import("./sonos.js");
      const live = await findUpcomingTrackPosition({ name, artist });
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
  return announceOnSonos(message, {
    startPlayback: !!startPlayback,
    queuePosition: pos,
    preemptGeneration,
  });
}
