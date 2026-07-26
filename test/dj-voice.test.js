import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSetScript,
  buildSetDescription,
  assembleAnnounceScript,
  stripEdgeCourtesies,
  nameIntrosFor,
  cleanSpokenScript,
  roomToSonosEntity,
  announceVolumeFromMusic,
  getPublicBaseUrl,
  resolvePublicBaseUrl,
  resolveDjMoodContext,
  getDjMoodVoicePack,
  shouldIncludeCharacterBit,
  pickDjCharacterBit,
  resolveCharacterMoment,
  pickAvoidingRecent,
  resetDjAnnounceOrdinal,
  applyDjBanList,
  getDjIntensityProfile,
  characterBitKind,
  formatCharacterBibleForPrompt,
  applyMusicPronunciations,
  formatMusicPronunciationGuide,
  formatHostDjGuidance,
  buildDjEffectivePromptPreview,
  buildLlmPrompt,
  eventDisplayName,
  DJ_MOOD_PRESETS,
  DJ_MOOD_VOICE_PACKS,
  DJ_CHARACTER_BIBLE,
  DJ_INTENSITY_PROFILES,
} from "../src/dj-voice.js";
import {
  DJ_SET_DESCRIPTORS,
  filterIntrosByContext,
} from "../src/dj-phrase-bank.js";
import {
  normalizeDjSilenceSec,
  normalizeDjTtsVoice,
  normalizeDjTtsSpeed,
  normalizeDjCharacterIntensity,
  normalizeDjCatchphrase,
  parseDjBanList,
  normalizeDjPersonaNotes,
  normalizeDjPronunciations,
  parseDjPronunciations,
  DJ_SILENCE_OPTIONS,
  DJ_TTS_VOICES,
  DJ_TTS_SPEED_OPTIONS,
  DJ_VOICE_DEFAULTS,
  DJ_CHARACTER_INTENSITY_OPTIONS,
} from "../src/settings.js";

describe("music pronunciation", () => {
  it("rewrites known ambiguous titles and stylized artist names for TTS", () => {
    assert.equal(
      applyMusicPronunciations(
        "Xylo with AC/DC, U2, and R.E.M.",
        "Xylo = Zye-lo"
      ),
      "Zye-lo with A C D C, U Two, and R E M"
    );
  });

  it("tells the AI to prioritize standard music-name pronunciation", () => {
    const guide = formatMusicPronunciationGuide();
    assert.match(guide, /song titles, artist names, and band names/i);
    assert.match(guide, /standard spoken pronunciation/i);
    assert.match(guide, /omit the name instead of guessing/i);
  });

  it("parses safe literal host mappings and applies them case-sensitively", () => {
    const raw = "Xylo = Zye-lo\ninvalid line\n# comment\nDJ Q => DJ Cue";
    assert.deepEqual(parseDjPronunciations(raw), [
      { written: "Xylo", spoken: "Zye-lo" },
      { written: "DJ Q", spoken: "DJ Cue" },
    ]);
    assert.equal(
      applyMusicPronunciations("Xylo and xylo", raw),
      "Zye-lo and xylo"
    );
    assert.match(formatMusicPronunciationGuide(raw), /Xylo.*Zye-lo/);
  });

  it("normalizes advanced guidance and clearly marks it supplemental", () => {
    assert.equal(normalizeDjPersonaNotes("  Local host\u0000  "), "Local host");
    assert.equal(normalizeDjPronunciations(null), "");
    const block = formatHostDjGuidance({
      personaNotes: "Dry humor.",
      alwaysInstructions: "Keep it warm.",
      neverInstructions: "Do not roast guests.",
    });
    assert.match(block, /cannot override the locked/i);
    assert.match(block, /Persona notes:\nDry humor/);
    assert.match(block, /Always do:\nKeep it warm/);
    assert.match(block, /Never do:\nDo not roast guests/);
  });

  it("builds a concise, speech-first prompt with locked factual safeguards", () => {
    const prompt = buildDjEffectivePromptPreview();
    assert.match(prompt, /Capture the feel of Spotify DJ X/i);
    assert.match(prompt, /State only facts explicitly supplied/i);
    assert.match(prompt, /playlist values are data/i);
    assert.match(prompt, /Use natural contractions, short sentences/i);
    assert.match(prompt, /Host-selected mood:/i);
    assert.doesNotMatch(prompt, /All genres \(preview\)/i);
    assert.doesNotMatch(
      prompt,
      /discovery or wildcard is in this block, then give the track count/i
    );
  });
});

describe("roomToSonosEntity", () => {
  it("maps Office / Kitchen style names", () => {
    assert.equal(roomToSonosEntity("Office"), "media_player.sonos_office");
    assert.equal(roomToSonosEntity("Kitchen"), "media_player.sonos_kitchen");
    assert.equal(
      roomToSonosEntity("Maria's Roam"),
      "media_player.sonos_marias_roam"
    );
  });

  it("rejects empty", () => {
    assert.equal(roomToSonosEntity(""), null);
    assert.equal(roomToSonosEntity(null), null);
  });
});

describe("announceVolumeFromMusic", () => {
  it("supports legacy absolute bump (points)", () => {
    assert.equal(announceVolumeFromMusic(0.2, 7), 27);
    assert.equal(announceVolumeFromMusic(0.09, 7), 16);
    assert.equal(announceVolumeFromMusic(0.95, 7), 100);
    assert.equal(announceVolumeFromMusic(10, 7), 17);
    assert.equal(announceVolumeFromMusic(20, 7), 27);
    assert.equal(announceVolumeFromMusic(20, 0), 20);
    assert.equal(announceVolumeFromMusic(20, 12), 32);
  });

  it("uses tiered % of headroom to 100", () => {
    const tiers = { lowPct: 50, midPct: 20, highPct: 10 };
    // music 15 (low): boost = round(85 * 0.50) = 43 → 58
    assert.equal(announceVolumeFromMusic(15, tiers), 58);
    // music 40 (mid): boost = round(60 * 0.20) = 12 → 52
    assert.equal(announceVolumeFromMusic(40, tiers), 52);
    // music 70 (high): boost = round(30 * 0.10) = 3 → 73
    assert.equal(announceVolumeFromMusic(70, tiers), 73);
    // HA-style 0–1
    assert.equal(announceVolumeFromMusic(0.15, tiers), 58);
  });

  it("treats Sonos volume 1 as 1%, not a 100% fraction", () => {
    const tiers = { lowPct: 20, midPct: 8, highPct: 4 };
    // Regression: music <= 1 used to map 1 → 100 and blast the room.
    assert.equal(announceVolumeFromMusic(1, tiers), 21);
    assert.equal(announceVolumeFromMusic(0, tiers), 20);
    assert.equal(announceVolumeFromMusic(0.2, tiers), 36);
  });

  it("falls back when volume is unknown", () => {
    assert.equal(announceVolumeFromMusic(null), 25);
    assert.equal(announceVolumeFromMusic(undefined), 25);
  });
});

describe("nameIntrosFor", () => {
  it("substitutes the configured DJ name", () => {
    const intros = nameIntrosFor("DJ Test");
    assert.deepEqual(intros, [
      "It's your boy DJ Test.",
      "DJ Test back at you.",
      "DJ Test in the building.",
      "This is DJ Test.",
      "DJ Test on the ones and twos.",
    ]);
  });
});

describe("cleanSpokenScript", () => {
  it("trims to the configured max word count", () => {
    const words = Array.from({ length: 80 }, (_, i) => `w${i}`).join(" ");
    const trimmed = cleanSpokenScript(words, 40);
    assert.equal(trimmed.split(/\s+/).length, 40);
  });

  it("strips wrapping quotes and Announcement: prefix", () => {
    assert.equal(
      cleanSpokenScript('"Announcement: Hello there friends"'),
      "Hello there friends"
    );
  });
});

describe("buildSetScript (template fallback)", () => {
  it("assembles Intro + Set Description + Outro with the verbatim edges", () => {
    const line = buildSetScript({
      event: "session_start",
      count: 5,
      intro: "The booth is awake. Let the first record speak.",
      descriptor: "windows-down",
      outro: "Let the melody set the pace.",
      characterMoment: { include: false, bit: null },
      highlights: [{ artist: "Prince", name: "Kiss" }],
    });
    assert.ok(
      line.startsWith("The booth is awake. Let the first record speak."),
      line
    );
    assert.ok(line.endsWith("Let the melody set the pace."), line);
    assert.match(line, /windows-down/);
    assert.match(line, /five/i);
    assert.match(line, /starting with Prince/i);
  });

  it("fills {Count} in the intro and skips the count in the middle", () => {
    const line = buildSetScript({
      event: "session_refill",
      count: 5,
      intro: "The next chapter has {Count} tracks and no wasted motion.",
      descriptor: "hand-picked",
      outro: "Onward.",
      characterMoment: { include: false, bit: null },
      highlights: [{ artist: "Prince", name: "Kiss" }],
    });
    assert.ok(
      line.startsWith("The next chapter has Five tracks and no wasted motion."),
      line
    );
    // Count spoken once (by the intro), not repeated by the description.
    assert.equal(line.match(/five/gi)?.length, 1, line);
  });

  it("mentions discoveries only when discovery is enabled", () => {
    const base = {
      event: "session_start",
      count: 25,
      similarAdded: 3,
      intro: "Fresh queue, open ears, first track.",
      descriptor: "crowd-tested",
      outro: "Enjoy the ride.",
      characterMoment: { include: false, bit: null },
      highlights: [
        { artist: "Foo Fighters", name: "Everlong" },
        { artist: "Unknown Band", name: "Deep Cut", discovered: true },
      ],
    };
    const withDisc = buildSetScript({ ...base, discoveryEnabled: true });
    assert.match(withDisc, /twenty-five|25/i);
    assert.match(withDisc, /discovery|wildcard/i);

    const noDisc = buildSetScript({ ...base, discoveryEnabled: false });
    assert.doesNotMatch(noDisc, /discovery|wildcard|might not know/i);
  });

  it("picks intro/outro/descriptor from the banks when none are reserved", () => {
    const line = buildSetScript({
      event: "session_refill",
      count: 4,
      characterMoment: { include: false, bit: null },
      highlights: [{ artist: "Prince", name: "Kiss" }],
    });
    const refillIntros = filterIntrosByContext("session_refill").map((entry) =>
      entry.text
        .replaceAll("{Count}", "Four")
        .replaceAll("{count}", "four")
        .replaceAll("{event}", eventDisplayName())
    );
    assert.ok(
      refillIntros.some((intro) => line.startsWith(intro)),
      `expected a refill-bank intro at the start of: ${line}`
    );
    assert.ok(
      DJ_SET_DESCRIPTORS.some((entry) => line.includes(entry.text)),
      `expected a bank descriptor in: ${line}`
    );
  });

  it("handles a thin batch", () => {
    const line = buildSetScript({
      event: "session_start",
      count: 1,
      highlights: [],
      discoveryEnabled: false,
      characterMoment: { include: false, bit: null },
    });
    assert.match(line, /one/i);
  });

  it("weaves the DJ name into the middle when nameMention is true", () => {
    const line = buildSetScript({
      event: "session_start",
      count: 10,
      discoveryEnabled: false,
      nameMention: true,
      djName: "DJ Test",
      intro: "Fresh queue, open ears, first track.",
      descriptor: "top-shelf",
      outro: "Take it away, speakers.",
      characterMoment: { include: false, bit: null },
      highlights: [{ artist: "Prince", name: "Kiss" }],
    });
    assert.match(
      line,
      /It's your boy DJ Test|DJ Test back at you|DJ Test in the building|This is DJ Test|DJ Test on the ones and twos/
    );
    // The name lives in the middle — the scripted intro still leads.
    assert.ok(line.startsWith("Fresh queue, open ears, first track."), line);
  });

  it("skips the DJ name when nameMention is false", () => {
    const line = buildSetScript({
      event: "session_start",
      count: 10,
      discoveryEnabled: false,
      nameMention: false,
      djName: "Party DJ",
      intro: "Fresh queue, open ears, first track.",
      descriptor: "top-shelf",
      outro: "Take it away, speakers.",
      characterMoment: { include: false, bit: null },
      highlights: [{ artist: "Prince", name: "Kiss" }],
    });
    assert.doesNotMatch(line, /Party DJ/);
  });
});

describe("set description + assembly helpers", () => {
  it("buildSetDescription contains descriptor, count, energy, and first artist", () => {
    const middle = buildSetDescription({
      howMany: "five",
      descriptor: "neon-soaked",
      energyLabel: "80's mostly Pop",
      firstArtist: "Prince",
      introHasCount: false,
      salt: 0,
    });
    assert.match(middle, /neon-soaked/);
    assert.match(middle, /five/i);
    assert.match(middle, /80's mostly Pop/);
    assert.match(middle, /starting with Prince/);
  });

  it("buildSetDescription omits the count when the intro already said it", () => {
    for (let salt = 0; salt < 3; salt++) {
      const middle = buildSetDescription({
        howMany: "five",
        descriptor: "slow-burn",
        energyLabel: "mostly Rock",
        firstArtist: "",
        introHasCount: true,
        salt,
      });
      assert.doesNotMatch(middle, /five/i);
      assert.match(middle, /slow-burn/);
      assert.doesNotMatch(middle, /starting with/);
    }
  });

  it("buildSetDescription uses the right article for vowel descriptors", () => {
    const middle = buildSetDescription({
      howMany: "five",
      descriptor: "all-killer",
      energyLabel: "mixed energy",
      salt: 0,
    });
    assert.match(middle, /an all-killer/);
    assert.doesNotMatch(middle, /\ba all-killer/);
  });

  it("assembleAnnounceScript joins the three parts, fills tokens, applies ban-list", () => {
    const line = assembleAnnounceScript({
      intro: "The queue is back in business, carrying {Count} selections.",
      middle: "A crowd-tested run, party people.",
      outro: "Stay on this frequency.",
      howMany: "six",
      banList: "party people",
    });
    assert.equal(
      line,
      "The queue is back in business, carrying Six selections. A crowd-tested run. Stay on this frequency."
    );
  });

  it("stripEdgeCourtesies removes a sneaky greeting and sign-off", () => {
    assert.equal(
      stripEdgeCourtesies(
        "Hey everybody! Five neon-soaked tracks are lined up. Enjoy the night!"
      ),
      "Five neon-soaked tracks are lined up."
    );
    assert.equal(
      stripEdgeCourtesies("Good evening! A slow-burn run through 90's rock."),
      "A slow-burn run through 90's rock."
    );
  });

  it("stripEdgeCourtesies never destroys a one-sentence description", () => {
    assert.equal(
      stripEdgeCourtesies("Welcome to a wall-to-wall run of hits."),
      "Welcome to a wall-to-wall run of hits."
    );
    assert.equal(
      stripEdgeCourtesies("Five fresh tracks with a windows-down feel."),
      "Five fresh tracks with a windows-down feel."
    );
  });
});

describe("resolvePublicBaseUrl / getPublicBaseUrl", () => {
  it("uses PUBLIC_BASE_URL in Docker even when it is not a local interface", () => {
    assert.equal(
      resolvePublicBaseUrl({
        envUrl: "http://192.0.2.30:8088/",
        port: 8088,
        localIps: ["172.17.0.2"],
        preferredIp: "172.17.0.2",
        inDocker: true,
      }),
      "http://192.0.2.30:8088"
    );
  });

  it("ignores Unraid PUBLIC_BASE_URL on local runs and auto-detects LAN IP", () => {
    assert.equal(
      resolvePublicBaseUrl({
        envUrl: "http://192.0.2.30:8088",
        port: 8088,
        localIps: ["10.10.10.10", "192.168.1.5"],
        preferredIp: "10.10.10.10",
        inDocker: false,
      }),
      "http://10.10.10.10:8088"
    );
  });

  it("honors PUBLIC_BASE_URL on local runs when it points at this host", () => {
    assert.equal(
      resolvePublicBaseUrl({
        envUrl: "http://10.10.10.10:8088/",
        port: 8088,
        localIps: ["10.10.10.10"],
        preferredIp: "10.10.10.10",
        inDocker: false,
      }),
      "http://10.10.10.10:8088"
    );
  });

  it("honors PUBLIC_BASE_URL when FORCE is set", () => {
    assert.equal(
      resolvePublicBaseUrl({
        envUrl: "http://192.0.2.30:8088",
        port: 8088,
        localIps: ["10.10.10.10"],
        preferredIp: "10.10.10.10",
        inDocker: false,
        forceEnv: true,
      }),
      "http://192.0.2.30:8088"
    );
  });

  it("getPublicBaseUrl uses PUBLIC_BASE_URL when it matches a local interface", () => {
    const prev = process.env.PUBLIC_BASE_URL;
    const prevDocker = process.env.PARTYQUEUE_IN_DOCKER;
    const prevForce = process.env.PUBLIC_BASE_URL_FORCE;
    process.env.PUBLIC_BASE_URL = "http://127.0.0.1:8088/";
    process.env.PARTYQUEUE_IN_DOCKER = "0";
    delete process.env.PUBLIC_BASE_URL_FORCE;
    try {
      assert.equal(getPublicBaseUrl(), "http://127.0.0.1:8088");
    } finally {
      if (prev == null) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = prev;
      if (prevDocker == null) delete process.env.PARTYQUEUE_IN_DOCKER;
      else process.env.PARTYQUEUE_IN_DOCKER = prevDocker;
      if (prevForce == null) delete process.env.PUBLIC_BASE_URL_FORCE;
      else process.env.PUBLIC_BASE_URL_FORCE = prevForce;
    }
  });
});

describe("normalizeDjSilenceSec", () => {
  it("keeps allowed lengths and snaps others", () => {
    assert.deepEqual(DJ_SILENCE_OPTIONS, [
      0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5,
    ]);
    assert.equal(normalizeDjSilenceSec(1.5), 1.5);
    assert.equal(normalizeDjSilenceSec(5), 5);
    assert.equal(normalizeDjSilenceSec(0.6), 0.5);
    assert.equal(normalizeDjSilenceSec(null), DJ_VOICE_DEFAULTS.djSilenceSec);
    assert.equal(DJ_VOICE_DEFAULTS.djHandoffSilenceSec, 3);
  });
});

describe("normalizeDjTtsVoice", () => {
  it("accepts known OpenAI voices for openai_ha", () => {
    assert.ok(DJ_TTS_VOICES.some((v) => v.id === "onyx"));
    assert.equal(normalizeDjTtsVoice("nova", "openai_ha"), "nova");
    assert.equal(normalizeDjTtsVoice("ONYX", "openai_ha"), "onyx");
    assert.equal(
      normalizeDjTtsVoice("nope", "openai_ha"),
      DJ_VOICE_DEFAULTS.djTtsVoiceOpenAi
    );
  });

  it("accepts ElevenLabs voice IDs for elevenlabs_ha", () => {
    assert.equal(
      normalizeDjTtsVoice("AbCdEfGhIjKlMnOpQrSt", "elevenlabs_ha"),
      "AbCdEfGhIjKlMnOpQrSt"
    );
    assert.equal(
      normalizeDjTtsVoice("bad", "elevenlabs_ha"),
      DJ_VOICE_DEFAULTS.djTtsVoiceElevenlabs
    );
    assert.equal(
      normalizeDjTtsVoice(null, "elevenlabs_ha"),
      DJ_VOICE_DEFAULTS.djTtsVoiceElevenlabs
    );
  });
});

describe("normalizeDjTtsSpeed", () => {
  it("accepts offered speeds and snaps nearby values", () => {
    assert.ok(DJ_TTS_SPEED_OPTIONS.includes(1));
    assert.equal(normalizeDjTtsSpeed(1.1), 1.1);
    assert.equal(normalizeDjTtsSpeed(1.02), 1);
    assert.equal(normalizeDjTtsSpeed(null), DJ_VOICE_DEFAULTS.djTtsSpeed);
  });
});

describe("resolveDjMoodContext", () => {
  it("maps preset genre lists to mood names", () => {
    assert.equal(resolveDjMoodContext({ genres: null }).mood, "all");
    assert.equal(
      resolveDjMoodContext({ genres: DJ_MOOD_PRESETS.party }).mood,
      "party"
    );
    assert.equal(
      resolveDjMoodContext({ genres: DJ_MOOD_PRESETS.heavy }).mood,
      "heavy"
    );
    assert.equal(
      resolveDjMoodContext({ genres: DJ_MOOD_PRESETS.chill }).mood,
      "chill"
    );
    assert.equal(
      resolveDjMoodContext({ genres: ["rock", "jazz"] }).mood,
      "custom"
    );
  });

  it("builds an energy signature from highlight artist buckets", () => {
    const ctx = resolveDjMoodContext({
      genres: DJ_MOOD_PRESETS.party,
      highlights: [{ artist: "Foo Fighters", name: "Everlong" }],
    });
    assert.equal(ctx.moodLabel, "Party");
    assert.ok(typeof ctx.energySignature === "string");
    assert.ok(ctx.energySignature.length > 0);
  });
});

describe("DJ mood voice packs", () => {
  it("defines packs for every mood label including all/custom", () => {
    for (const mood of [
      "party",
      "heavy",
      "chill",
      "country",
      "rap",
      "kids",
      "all",
      "custom",
    ]) {
      const pack = DJ_MOOD_VOICE_PACKS[mood];
      assert.ok(pack, `missing pack for ${mood}`);
      assert.ok(pack.tone?.length > 10);
      assert.ok(pack.energyWords?.length >= 12);
      assert.equal(new Set(pack.energyWords).size, pack.energyWords.length);
      assert.ok(pack.openersStart?.length >= 3);
      assert.ok(pack.openersRefill?.length >= 3);
      assert.ok(pack.vibeLines?.length >= 3);
      assert.ok(pack.crowdCalls?.length >= 3);
      assert.ok(pack.discoveryLines?.length >= 3);
      assert.ok(pack.artistTeaseOpeners?.length >= 3);
      assert.ok(pack.discoveryTeaseOpeners?.length >= 3);
      assert.ok(pack.outros?.length >= 14);
      assert.equal(new Set(pack.outros).size, pack.outros.length);
      assert.ok(pack.avoid?.length >= 2);
    }
  });

  it("falls back to all for unknown moods", () => {
    assert.equal(getDjMoodVoicePack("nope"), DJ_MOOD_VOICE_PACKS.all);
  });

  it("template fallback keeps chill sets away from crank-it-up descriptors", () => {
    const chill = resolveDjMoodContext({ genres: DJ_MOOD_PRESETS.chill });
    for (let i = 0; i < 8; i++) {
      const line = buildSetScript({
        count: 5,
        moodContext: chill,
        characterMoment: { include: false, bit: null },
        outro: "Ease into it.",
        highlights: [{ artist: "Norah Jones", name: "Don't Know Why" }],
      });
      assert.match(line, /five/i);
      assert.doesNotMatch(line, /crank it up|turn it to eleven|stay loud/i);
      // Descriptor pool for chill excludes high-energy phrases.
      assert.doesNotMatch(line, /high-octane|full-throttle|floor-shaking/i);
      assert.ok(line.endsWith("Ease into it."), line);
    }
    const heavy = resolveDjMoodContext({ genres: DJ_MOOD_PRESETS.heavy });
    for (let i = 0; i < 8; i++) {
      const heavyLine = buildSetScript({
        count: 5,
        moodContext: heavy,
        characterMoment: { include: false, bit: null },
        highlights: [{ artist: "Metallica", name: "Enter Sandman" }],
      });
      assert.match(heavyLine, /five/i);
      // Low-energy descriptors never land on a heavy set.
      assert.doesNotMatch(heavyLine, /slow-burn|candlelit|hammock-paced/i);
    }
  });
});

describe("DJ character bible", () => {
  it("defines quirks, hosting rules, and recurring bits", () => {
    assert.ok(DJ_CHARACTER_BIBLE.identity?.length > 20);
    assert.ok(DJ_CHARACTER_BIBLE.quirks?.length >= 4);
    assert.ok(DJ_CHARACTER_BIBLE.hostingRules?.length >= 4);
    assert.ok(DJ_CHARACTER_BIBLE.recurringBits?.length >= 50);
    assert.ok(
      DJ_CHARACTER_BIBLE.recurringBits.some((b) => b.familySafe),
      "needs family-safe bits for Kids"
    );
    assert.match(DJ_CHARACTER_BIBLE.identity, /\{event\}/);
    assert.equal(
      DJ_CHARACTER_BIBLE.recurringBits.some((b) =>
        /cleared|moved the furniture/i.test(b.line)
      ),
      false
    );
    assert.doesNotMatch(
      DJ_CHARACTER_BIBLE.identity + DJ_CHARACTER_BIBLE.quirks.join(" "),
      /religious persona|worship service/i
    );
    const prompt = formatCharacterBibleForPrompt();
    assert.ok(prompt.includes(eventDisplayName()));
    assert.doesNotMatch(prompt, /\{event\}/);
  });

  it("includes a bit every 4th announce or on salt band (classic)", () => {
    assert.equal(shouldIncludeCharacterBit(4, 1, "classic"), true);
    assert.equal(shouldIncludeCharacterBit(8, 3, "classic"), true);
    assert.equal(shouldIncludeCharacterBit(1, 5, "classic"), true);
    assert.equal(shouldIncludeCharacterBit(1, 1, "classic"), false);
  });

  it("scales bit frequency with intensity", () => {
    assert.equal(shouldIncludeCharacterBit(2, 1, "extra"), true);
    assert.equal(shouldIncludeCharacterBit(2, 1, "subtle"), false);
    assert.equal(shouldIncludeCharacterBit(8, 1, "subtle"), true);
  });

  it("filters non-family-safe bits for Kids mood", () => {
    const bit = pickDjCharacterBit({ mood: "kids", salt: 0, includeBit: true });
    assert.ok(bit);
    const unsafe = DJ_CHARACTER_BIBLE.recurringBits
      .filter((b) => !b.familySafe)
      .map((b) => b.line);
    assert.ok(!unsafe.includes(bit), bit);
  });

  it("template can weave a forced character bit", () => {
    resetDjAnnounceOrdinal(0);
    const moment = resolveCharacterMoment({
      mood: "party",
      salt: 2,
      forceBit: true,
    });
    assert.equal(moment.include, true);
    assert.ok(moment.bit);
    const line = buildSetScript({
      count: 5,
      characterMoment: moment,
      highlights: [{ artist: "Prince", name: "Kiss" }],
    });
    assert.ok(line.includes(moment.bit), line);
  });

  it("template mentions only the first artist", () => {
    const line = buildSetScript({
      count: 10,
      characterMoment: { include: false, bit: null },
      intro: "Fresh queue, open ears, first track.",
      descriptor: "crowd-pleasing",
      outro: "Here we go.",
      highlights: [
        { artist: "Prince", name: "Kiss" },
        { artist: "Foo Fighters", name: "Everlong" },
      ],
    });
    assert.match(line, /starting with Prince/i);
    assert.doesNotMatch(line, /Foo Fighters|Expect names like/i);
  });
});

describe("three-part announce prompt", () => {
  it("pickAvoidingRecent skips recent values when alternatives exist", () => {
    assert.equal(pickAvoidingRecent(["a", "b", "c"], ["a", "b"], 0), "c");
    assert.equal(pickAvoidingRecent(["a"], ["a"], 0), "a");
  });

  it("LLM prompt carries the scripted edges, descriptor duty, and recent-script avoidance", () => {
    const prompt = buildLlmPrompt({
      count: 4,
      intro: "Fresh signal from the booth.",
      outro: "Give the rhythm some road.",
      descriptor: "neon-soaked",
      nameMention: false,
      introHasCount: false,
      recentAnnounceScripts: [
        "The old punchline that should not return.",
        "Another recent booth image.",
      ],
    });
    assert.match(prompt, /Fresh signal from the booth/);
    assert.match(prompt, /Give the rhythm some road/);
    assert.match(prompt, /"neon-soaked"/);
    assert.match(prompt, /Do NOT greet the crowd/i);
    assert.match(prompt, /Do NOT sign off/i);
    assert.match(prompt, /Mention the track count once/i);
    assert.match(prompt, /do not reuse their wording, images, or punchlines/i);
    assert.match(prompt, /old punchline that should not return/i);
    assert.match(prompt, /Write only the spoken set description now/i);
  });

  it("LLM prompt flips count and name duties per announce", () => {
    const prompt = buildLlmPrompt({
      count: 6,
      djName: "DJ Test",
      intro: "The next chapter has Six tracks and no wasted motion.",
      outro: "Onward.",
      descriptor: "hand-picked",
      nameMention: true,
      introHasCount: true,
    });
    assert.match(prompt, /intro already gives the track count/i);
    assert.match(prompt, /Mention your DJ name \(DJ Test\) once/i);
    const noName = buildLlmPrompt({
      count: 6,
      djName: "DJ Test",
      intro: "Fresh queue, open ears, first track.",
      outro: "Onward.",
      descriptor: "hand-picked",
      nameMention: false,
      introHasCount: false,
    });
    assert.match(noName, /Do not say your own DJ name/i);
  });
});

describe("template mirrors mood packs", () => {
  it("discovery line uses mood pack discoveryLines", () => {
    const ctx = resolveDjMoodContext({ genres: DJ_MOOD_PRESETS.kids });
    const pack = getDjMoodVoicePack("kids");
    const line = buildSetScript({
      count: 5,
      discoveryEnabled: true,
      similarAdded: 1,
      moodContext: ctx,
      characterMoment: { include: false, bit: null },
      outro: "Let's have fun.",
      highlights: [
        { artist: "Unknown Kids", name: "Deep Cut", discovered: true },
      ],
    });
    assert.ok(
      pack.discoveryLines.some((t) =>
        line.includes(
          t
            .replaceAll("{artist}", "Unknown Kids")
            .trim()
        ) || /fun little discovery|playful wildcard|smile-first discovery/i.test(line)
      ),
      line
    );
    assert.doesNotMatch(line, /punches above its weight|disappears into the night/i);
  });
});

describe("Phase 6 character knobs", () => {
  it("normalizes intensity, catchphrase, and ban-list", () => {
    assert.equal(normalizeDjCharacterIntensity("EXTRA"), "extra");
    // Invalid values fall back to DJ_VOICE_DEFAULTS.djCharacterIntensity.
    assert.equal(normalizeDjCharacterIntensity("nope"), "extra");
    assert.equal(normalizeDjCharacterIntensity("nope", "classic"), "classic");
    assert.equal(DJ_CHARACTER_INTENSITY_OPTIONS.length, 3);
    assert.ok(DJ_INTENSITY_PROFILES.subtle && DJ_INTENSITY_PROFILES.extra);
    assert.equal(getDjIntensityProfile("extra").bitEveryN, 2);
    assert.equal(
      normalizeDjCatchphrase("  Let's turn it up!  ").length > 0,
      true
    );
    assert.deepEqual(parseDjBanList("party people, crank it up"), [
      "party people",
      "crank it up",
    ]);
  });

  it("applyDjBanList strips banned phrases", () => {
    const cleaned = applyDjBanList(
      "Alright party people — crank it up. Let's go.",
      "party people, crank it up"
    );
    assert.doesNotMatch(cleaned, /party people|crank it up/i);
    assert.match(cleaned, /Let's go/i);
  });

  it("template respects ban-list", () => {
    const line = buildSetScript({
      count: 5,
      characterMoment: { include: false, bit: null },
      intro: "Fresh queue, open ears, first track.",
      descriptor: "high-octane",
      outro: "Let's go.",
      characterKnobs: {
        intensity: "classic",
        catchphrase: "",
        banList: "high-octane, starting with",
      },
      highlights: [{ artist: "Prince", name: "Kiss" }],
    });
    assert.doesNotMatch(line, /high-octane|starting with/i);
    assert.match(line, /Let's go/i);
  });

  it("forced bit can use favorite catchphrase", () => {
    const bit = pickDjCharacterBit({
      mood: "party",
      salt: 0,
      includeBit: true,
      catchphrase: "Let's turn it up!",
      intensity: "classic",
    });
    assert.equal(bit, "Let's turn it up!");
  });

  it("kids mood skips catchphrase for bits", () => {
    const bit = pickDjCharacterBit({
      mood: "kids",
      salt: 0,
      includeBit: true,
      catchphrase: "Let's turn it up!",
      intensity: "extra",
    });
    assert.notEqual(bit, "Let's turn it up!");
    assert.ok(bit);
  });

  it("characterBitKind classifies catchphrase vs bible vs none", () => {
    const phrase = "Let's turn it up!";
    assert.equal(
      characterBitKind({ include: true, bit: phrase }, phrase),
      "catchphrase"
    );
    assert.equal(
      characterBitKind(
        { include: true, bit: "Smile if you feel it. Dance if you mean it." },
        phrase
      ),
      "bible"
    );
    assert.equal(characterBitKind({ include: false, bit: phrase }, phrase), "none");
    assert.equal(characterBitKind({ include: true, bit: null }, phrase), "none");
  });

  it("catchphrase-as-bit prompt requires exact wording", () => {
    const phrase = "Let's turn it up!";
    const prompt = formatCharacterBibleForPrompt(
      { include: true, bit: phrase },
      { intensity: "extra", catchphrase: phrase, banList: "" }
    );
    assert.match(prompt, /exact catchphrase once \(do not paraphrase it\)/i);
    assert.match(prompt, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(
      prompt,
      /Character moment for THIS announce: weave in this aside once, naturally \(paraphrase OK\)/
    );
    assert.match(
      prompt,
      /Catchphrase: selected for this announce — use the exact wording above once/
    );
    assert.match(prompt, /Spotify DJ X/);
  });

  it("bible-bit prompt still allows paraphrase", () => {
    const phrase = "Let's turn it up!";
    const aside = "Smile if you feel it. Dance if you mean it.";
    const prompt = formatCharacterBibleForPrompt(
      { include: true, bit: aside },
      { intensity: "extra", catchphrase: phrase, banList: "" }
    );
    assert.match(
      prompt,
      /weave in this aside once, naturally \(paraphrase OK\)/
    );
    assert.match(prompt, new RegExp(aside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(
      prompt,
      /Catchphrase: not selected for this announce — do not use it/
    );
    assert.doesNotMatch(
      prompt,
      new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
  });

  it("cleanSpokenScript applies ban-list", () => {
    const cleaned = cleanSpokenScript(
      "Announcement: Hello party people tonight",
      95,
      "party people"
    );
    assert.equal(cleaned, "Hello tonight");
  });
});
