import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSetScript,
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
  resolveAnnounceShape,
  pickAvoidingRecent,
  recordAnnounceShape,
  getRecentAnnounceMemory,
  resetDjAnnounceOrdinal,
  applyDjBanList,
  getDjIntensityProfile,
  characterBitKind,
  formatCharacterBibleForPrompt,
  eventDisplayName,
  DJ_MOOD_PRESETS,
  DJ_MOOD_VOICE_PACKS,
  DJ_CHARACTER_BIBLE,
  DJ_OPENER_SHAPES,
  DJ_BODY_SHAPES,
  DJ_INTENSITY_PROFILES,
} from "../src/dj-voice.js";
import {
  normalizeDjSilenceSec,
  normalizeDjTtsVoice,
  normalizeDjTtsSpeed,
  normalizeDjCharacterIntensity,
  normalizeDjCatchphrase,
  parseDjBanList,
  DJ_SILENCE_OPTIONS,
  DJ_TTS_VOICES,
  DJ_TTS_SPEED_OPTIONS,
  DJ_VOICE_DEFAULTS,
  DJ_CHARACTER_INTENSITY_OPTIONS,
} from "../src/settings.js";

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

describe("buildSetScript", () => {
  it("mentions discoveries only when discovery is enabled", () => {
    const withDisc = buildSetScript({
      event: "session_start",
      count: 25,
      similarAdded: 3,
      discoveryEnabled: true,
      beatFocus: "count_vibe",
      highlights: [
        { artist: "Foo Fighters", name: "Everlong" },
        { artist: "Unknown Band", name: "Deep Cut", discovered: true },
      ],
    });
    assert.match(withDisc, /twenty-five|25/i);
    assert.match(withDisc, /discovery|wildcard/i);

    const noDisc = buildSetScript({
      event: "session_start",
      count: 25,
      similarAdded: 3,
      discoveryEnabled: false,
      beatFocus: "count_vibe",
      highlights: [
        { artist: "Foo Fighters", name: "Everlong" },
        { artist: "Unknown Band", name: "Deep Cut", discovered: true },
      ],
    });
    assert.doesNotMatch(noDisc, /discovery|wildcard|might not know/i);
  });

  it("varies refill vs fresh openers and ends with an outro", () => {
    const refill = buildSetScript({
      event: "session_refill",
      count: 25,
      discoveryEnabled: false,
      nameIntro: false,
      announceShape: resolveAnnounceShape({
        nameIntroForced: false,
        hasArtist: true,
        salt: 1,
        openerShape: "cold_open",
        bodyShape: "energy_first",
        outro: "Let's go.",
      }),
      characterMoment: { include: false, bit: null },
      highlights: [{ artist: "Prince", name: "Kiss" }],
    });
    assert.match(refill, /more|keeping|another/i);
    assert.match(refill, /Let's go\./i);
  });

  it("handles a thin batch", () => {
    const line = buildSetScript({
      event: "session_start",
      count: 1,
      highlights: [],
      discoveryEnabled: false,
      beatFocus: "count_tag",
    });
    assert.match(line, /one/i);
  });

  it("uses a Party DJ name intro when nameIntro is true", () => {
    const line = buildSetScript({
      event: "session_start",
      count: 10,
      discoveryEnabled: false,
      nameIntro: true,
      djName: "Party DJ",
      highlights: [{ artist: "Prince", name: "Kiss" }],
    });
    assert.match(
      line,
      /It's your boy Party DJ|Party DJ back at you|Party DJ in the building|This is Party DJ|Party DJ on the ones and twos/
    );
  });

  it("uses a custom DJ name in intros", () => {
    const line = buildSetScript({
      event: "session_start",
      count: 10,
      discoveryEnabled: false,
      nameIntro: true,
      djName: "DJ Test",
      highlights: [{ artist: "Prince", name: "Kiss" }],
    });
    assert.match(
      line,
      /It's your boy DJ Test|DJ Test back at you|DJ Test in the building|This is DJ Test|DJ Test on the ones and twos/
    );
  });

  it("skips name intro when nameIntro is false", () => {
    const line = buildSetScript({
      event: "session_start",
      count: 10,
      discoveryEnabled: false,
      nameIntro: false,
      djName: "Party DJ",
      highlights: [{ artist: "Prince", name: "Kiss" }],
    });
    assert.doesNotMatch(
      line,
      /^It's your boy Party DJ|^Party DJ back at you|^Party DJ in the building|^This is Party DJ|^Party DJ on the ones and twos/
    );
  });
});

describe("resolvePublicBaseUrl / getPublicBaseUrl", () => {
  it("uses PUBLIC_BASE_URL in Docker even when it is not a local interface", () => {
    assert.equal(
      resolvePublicBaseUrl({
        envUrl: "http://10.10.1.30:8088/",
        port: 8088,
        localIps: ["172.17.0.2"],
        preferredIp: "172.17.0.2",
        inDocker: true,
      }),
      "http://10.10.1.30:8088"
    );
  });

  it("ignores Unraid PUBLIC_BASE_URL on local runs and auto-detects LAN IP", () => {
    assert.equal(
      resolvePublicBaseUrl({
        envUrl: "http://10.10.1.30:8088",
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
        envUrl: "http://10.10.1.30:8088",
        port: 8088,
        localIps: ["10.10.10.10"],
        preferredIp: "10.10.10.10",
        inDocker: false,
        forceEnv: true,
      }),
      "http://10.10.1.30:8088"
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
      normalizeDjTtsVoice("CeNX9CMwmxDxUF5Q2Inm", "elevenlabs_ha"),
      "CeNX9CMwmxDxUF5Q2Inm"
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
      assert.ok(pack.energyWords?.length >= 3);
      assert.ok(pack.openersStart?.length >= 3);
      assert.ok(pack.openersRefill?.length >= 3);
      assert.ok(pack.vibeLines?.length >= 3);
      assert.ok(pack.crowdCalls?.length >= 3);
      assert.ok(pack.discoveryLines?.length >= 3);
      assert.ok(pack.artistTeaseOpeners?.length >= 3);
      assert.ok(pack.discoveryTeaseOpeners?.length >= 3);
      assert.ok(pack.outros?.length >= 4);
      assert.ok(pack.avoid?.length >= 2);
    }
  });

  it("falls back to all for unknown moods", () => {
    assert.equal(getDjMoodVoicePack("nope"), DJ_MOOD_VOICE_PACKS.all);
  });

  it("template fallback uses chill outros, not crank-it-up", () => {
    const chill = resolveDjMoodContext({ genres: DJ_MOOD_PRESETS.chill });
    const line = buildSetScript({
      count: 5,
      nameIntro: false,
      moodContext: chill,
      beatFocus: "count_vibe_tag",
      highlights: [{ artist: "Norah Jones", name: "Don't Know Why" }],
    });
    assert.match(line, /five/i);
    assert.doesNotMatch(line, /crank it up|turn it to eleven|stay loud/i);
    const heavy = resolveDjMoodContext({ genres: DJ_MOOD_PRESETS.heavy });
    const heavyLine = buildSetScript({
      count: 5,
      nameIntro: false,
      moodContext: heavy,
      beatFocus: "count_vibe_tag",
      highlights: [{ artist: "Metallica", name: "Enter Sandman" }],
    });
    assert.match(heavyLine, /five/i);
    // Heavy pack closers lean loud; at least one of the vibe/outro cues should show.
    assert.ok(
      /loud|grit|crank|eleven|hit|teeth|weight|hot/i.test(heavyLine),
      heavyLine
    );
  });
});

describe("DJ character bible", () => {
  it("defines quirks, hosting rules, and recurring bits", () => {
    assert.ok(DJ_CHARACTER_BIBLE.identity?.length > 20);
    assert.ok(DJ_CHARACTER_BIBLE.quirks?.length >= 4);
    assert.ok(DJ_CHARACTER_BIBLE.hostingRules?.length >= 4);
    assert.ok(DJ_CHARACTER_BIBLE.recurringBits?.length >= 6);
    assert.ok(
      DJ_CHARACTER_BIBLE.recurringBits.some((b) => b.familySafe),
      "needs family-safe bits for Kids"
    );
    assert.match(DJ_CHARACTER_BIBLE.identity, /\{event\}/);
    assert.doesNotMatch(
      DJ_CHARACTER_BIBLE.identity + DJ_CHARACTER_BIBLE.quirks.join(" "),
      /Holy Roller|Church Night|worship/i
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
      nameIntro: false,
      characterMoment: moment,
      highlights: [{ artist: "Prince", name: "Kiss" }],
    });
    assert.ok(line.includes(moment.bit), line);
  });

  it("template mentions at most one artist name-drop", () => {
    const line = buildSetScript({
      count: 10,
      nameIntro: false,
      characterMoment: { include: false, bit: null },
      announceShape: resolveAnnounceShape({
        nameIntroForced: false,
        hasArtist: true,
        salt: 1,
        openerShape: "cold_open",
        bodyShape: "energy_first",
        outro: "Here we go.",
      }),
      highlights: [
        { artist: "Prince", name: "Kiss" },
        { artist: "Foo Fighters", name: "Everlong" },
      ],
    });
    assert.match(line, /Prince is in the mix/i);
    assert.doesNotMatch(line, /Foo Fighters|Expect names like/i);
  });
});

describe("DJ announce shape anti-repeat", () => {
  it("defines opener and body shape catalogs", () => {
    for (const id of [
      "name_intro",
      "cold_open",
      "artist_tease",
      "discovery_tease",
    ]) {
      assert.ok(DJ_OPENER_SHAPES[id]?.instruction);
    }
    for (const id of ["energy_first", "artist_first", "crowd_call"]) {
      assert.ok(DJ_BODY_SHAPES[id]?.instruction);
    }
  });

  it("pickAvoidingRecent skips recent values when alternatives exist", () => {
    assert.equal(pickAvoidingRecent(["a", "b", "c"], ["a", "b"], 0), "c");
    assert.equal(pickAvoidingRecent(["a"], ["a"], 0), "a");
  });

  it("avoids repeating opener shape across consecutive resolves", () => {
    resetDjAnnounceOrdinal(0);
    const a = resolveAnnounceShape({
      nameIntroForced: false,
      hasArtist: true,
      discoveryEnabled: true,
      similarAdded: 1,
      salt: 10,
      mood: "party",
    });
    recordAnnounceShape({
      openerShape: a.openerShape,
      bodyShape: a.bodyShape,
      outro: a.outro,
    });
    const b = resolveAnnounceShape({
      nameIntroForced: false,
      hasArtist: true,
      discoveryEnabled: true,
      similarAdded: 1,
      salt: 10,
      mood: "party",
    });
    assert.notEqual(b.openerShape, a.openerShape);
    assert.ok(getRecentAnnounceMemory().openerShapes.includes(a.openerShape));
  });

  it("forces name_intro when nameIntro is true", () => {
    const shape = resolveAnnounceShape({
      nameIntroForced: true,
      salt: 3,
      mood: "all",
    });
    assert.equal(shape.openerShape, "name_intro");
    assert.equal(shape.nameIntro, true);
  });

  it("rotates flavor beats so count/vibe/tagline are not always stacked", () => {
    resetDjAnnounceOrdinal(0);
    const shapes = [];
    for (let salt = 0; salt < 12; salt++) {
      const shape = resolveAnnounceShape({
        nameIntroForced: false,
        hasArtist: true,
        salt,
        mood: "party",
      });
      shapes.push(shape);
      recordAnnounceShape({
        openerShape: shape.openerShape,
        bodyShape: shape.bodyShape,
        beatFocus: shape.beatFocus,
        outro: shape.outro,
      });
    }
    const foci = new Set(shapes.map((s) => s.beatFocus));
    assert.ok(foci.size >= 2, `expected multiple beat foci, got ${[...foci]}`);
    assert.ok(
      shapes.some((s) => !(s.includeCount && s.includeVibe && s.includeOutro)),
      "expected at least one announce to drop count, vibe, or tagline"
    );
    const short = buildSetScript({
      count: 5,
      nameIntro: false,
      beatFocus: "count_tag",
      characterMoment: { include: false, bit: null },
      announceShape: resolveAnnounceShape({
        nameIntroForced: false,
        salt: 1,
        openerShape: "cold_open",
        bodyShape: "energy_first",
        beatFocus: "count_tag",
        outro: "Let's go.",
      }),
      highlights: [{ artist: "Prince", name: "Kiss" }],
    });
    assert.match(short, /five/i);
    assert.match(short, /Let's go/i);
    assert.doesNotMatch(short, /We're talking/i);
  });

  it("template artist_tease opener mentions the artist up front", () => {
    resetDjAnnounceOrdinal(0);
    const shape = resolveAnnounceShape({
      nameIntroForced: false,
      hasArtist: true,
      salt: 0,
      openerShape: "artist_tease",
      bodyShape: "energy_first",
      outro: "Let's go.",
    });
    const line = buildSetScript({
      count: 5,
      nameIntro: false,
      announceShape: shape,
      characterMoment: { include: false, bit: null },
      highlights: [{ artist: "Prince", name: "Kiss" }],
    });
    assert.match(line, /Prince/i);
    assert.match(line, /five|5/i);
  });

  it("template discovery_tease opener when discoveries are enabled", () => {
    const shape = resolveAnnounceShape({
      nameIntroForced: false,
      discoveryEnabled: true,
      similarAdded: 1,
      hasArtist: true,
      salt: 0,
      openerShape: "discovery_tease",
      bodyShape: "crowd_call",
      outro: "Here we go.",
    });
    const line = buildSetScript({
      count: 5,
      discoveryEnabled: true,
      similarAdded: 1,
      announceShape: shape,
      characterMoment: { include: false, bit: null },
      highlights: [
        { artist: "Unknown Band", name: "Deep Cut", discovered: true },
      ],
    });
    assert.match(line, /discovery|wildcard|might not know/i);
  });
});

describe("Phase 5 template mirrors mood packs", () => {
  const fixtures = [
    {
      mood: "chill",
      artist: "Norah Jones",
      track: "Don't Know Why",
      must: /easy|cool|smooth|laid-back|settle|pace/i,
      mustNot: /crank it up|turn it to eleven|stay loud|make some noise/i,
      outroMustNot: /Crank it up|Turn it to eleven|Stay loud|Make some noise/,
    },
    {
      mood: "heavy",
      artist: "Metallica",
      track: "Enter Sandman",
      must: /loud|grit|heavy|teeth|weight|hot|volume|hit/i,
      mustNot: /easy pace|cooler stretch|smile-first|settle in for this cooler/i,
    },
    {
      mood: "kids",
      artist: "The Wiggles",
      track: "Hot Potato",
      must: /fun|smile|silly|friends|playful|family/i,
      mustNot: /crank it up|stay loud|turn it to eleven|drinks/i,
    },
    {
      mood: "country",
      artist: "Johnny Cash",
      track: "Folsom Prison Blues",
      must: /heart|road|night-drive|boots|story|wheels|ride/i,
      mustNot: /crank it up|turn it to eleven|lock in/i,
    },
  ];

  for (const fx of fixtures) {
    it(`cold_open template stays in ${fx.mood} pack (no generic rock collapse)`, () => {
      resetDjAnnounceOrdinal(0);
      const ctx = resolveDjMoodContext({
        genres: DJ_MOOD_PRESETS[fx.mood],
      });
      const pack = getDjMoodVoicePack(fx.mood);
      const shape = resolveAnnounceShape({
        nameIntroForced: false,
        hasArtist: true,
        salt: 2,
        mood: fx.mood,
        openerShape: "cold_open",
        bodyShape: "energy_first",
        outro: pack.outros[0],
      });
      const line = buildSetScript({
        count: 5,
        nameIntro: false,
        moodContext: ctx,
        announceShape: shape,
        characterMoment: { include: false, bit: null },
        highlights: [{ artist: fx.artist, name: fx.track }],
      });
      assert.match(line, /five/i);
      assert.match(line, fx.must, line);
      assert.doesNotMatch(line, fx.mustNot);
      if (fx.outroMustNot) assert.doesNotMatch(line, fx.outroMustNot);
      // Outro must be from this mood's pack.
      assert.ok(
        pack.outros.some((o) => line.endsWith(o) || line.includes(o)),
        `outro not from ${fx.mood} pack: ${line}`
      );
    });
  }

  it("crowd_call uses mood pack crowdCalls, not a generic room line", () => {
    const ctx = resolveDjMoodContext({ genres: DJ_MOOD_PRESETS.chill });
    const pack = getDjMoodVoicePack("chill");
    const shape = resolveAnnounceShape({
      nameIntroForced: false,
      hasArtist: true,
      salt: 0,
      mood: "chill",
      openerShape: "cold_open",
      bodyShape: "crowd_call",
      outro: "Ease into it.",
    });
    const line = buildSetScript({
      count: 5,
      moodContext: ctx,
      announceShape: shape,
      characterMoment: { include: false, bit: null },
      highlights: [{ artist: "Norah Jones", name: "Don't Know Why" }],
    });
    assert.ok(
      pack.crowdCalls.some((c) => line.includes(c)),
      line
    );
    assert.doesNotMatch(line, /this one's for the floor|Make some noise/i);
  });

  it("discovery body line uses mood pack discoveryLines", () => {
    const ctx = resolveDjMoodContext({ genres: DJ_MOOD_PRESETS.kids });
    const pack = getDjMoodVoicePack("kids");
    const shape = resolveAnnounceShape({
      nameIntroForced: false,
      discoveryEnabled: true,
      similarAdded: 1,
      hasArtist: true,
      salt: 0,
      mood: "kids",
      openerShape: "cold_open",
      bodyShape: "energy_first",
      outro: "Let's have fun.",
    });
    const line = buildSetScript({
      count: 5,
      discoveryEnabled: true,
      similarAdded: 1,
      moodContext: ctx,
      announceShape: shape,
      characterMoment: { include: false, bit: null },
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
      normalizeDjCatchphrase("  Keep the faith!  ").length > 0,
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
      nameIntro: false,
      characterMoment: { include: false, bit: null },
      announceShape: resolveAnnounceShape({
        nameIntroForced: false,
        salt: 0,
        openerShape: "cold_open",
        bodyShape: "energy_first",
        outro: "Let's go.",
      }),
      characterKnobs: {
        intensity: "classic",
        catchphrase: "",
        banList: "We're talking",
      },
      highlights: [{ artist: "Prince", name: "Kiss" }],
    });
    assert.doesNotMatch(line, /We're talking/i);
  });

  it("forced bit can use favorite catchphrase", () => {
    const bit = pickDjCharacterBit({
      mood: "party",
      salt: 0,
      includeBit: true,
      catchphrase: "Keep the faith!",
      intensity: "classic",
    });
    assert.equal(bit, "Keep the faith!");
  });

  it("kids mood skips catchphrase for bits", () => {
    const bit = pickDjCharacterBit({
      mood: "kids",
      salt: 0,
      includeBit: true,
      catchphrase: "Keep the faith!",
      intensity: "extra",
    });
    assert.notEqual(bit, "Keep the faith!");
    assert.ok(bit);
  });

  it("characterBitKind classifies catchphrase vs bible vs none", () => {
    const phrase = "Keep the faith — and keep it loud.";
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
    const phrase = "Keep the faith — and keep it loud.";
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
      /Favorite catchphrase: already assigned as this announce's character moment/
    );
  });

  it("bible-bit prompt still allows paraphrase", () => {
    const phrase = "Keep the faith — and keep it loud.";
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
      /Favorite catchphrase \(use sparingly, at most once, only when it fits\)/
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
