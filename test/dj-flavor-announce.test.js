import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SET_REQUEST_INTROS,
  SET_REQUEST_BLURBS,
  SONG_REQUEST_INTROS,
  SONG_REQUEST_BLURBS,
  ROTATE_MOOD_INTROS,
  ROTATE_MOOD_BLURBS,
  ROTATE_DECADE_INTROS,
  ROTATE_DECADE_BLURBS,
  fillFlavorTokens,
  pickFlavorAnnounceLines,
  cleanRotationFlavor,
} from "../src/dj-flavor-announce.js";
import {
  buildSetDescription,
  resetDjAnnounceOrdinal,
  writeSetScript,
} from "../src/dj-voice.js";
import { resetDjSetPacksForTests } from "../src/dj-set-packs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HA_STORE = path.join(__dirname, "..", "data", "home-assistant.json");
const HA_STORE_BAK = HA_STORE + ".testbak";
let savedHaUrl;
let savedHaToken;

function assertBank(intros, blurbs, token) {
  assert.equal(intros.length, 30);
  assert.equal(blurbs.length, 30);
  assert.ok(intros.every((line) => line.includes(token)));
  assert.ok(blurbs.every((line) => line.includes(token)));
}

describe("flavor announce banks", () => {
  it("has 30 unique lines per request and rotation bank", () => {
    assertBank(SET_REQUEST_INTROS, SET_REQUEST_BLURBS, "{artist}");
    assertBank(SONG_REQUEST_INTROS, SONG_REQUEST_BLURBS, "{guest}");
    assert.ok(SONG_REQUEST_INTROS.every((line) => line.includes("{song}")));
    assertBank(ROTATE_MOOD_INTROS, ROTATE_MOOD_BLURBS, "{mood}");
    assertBank(ROTATE_DECADE_INTROS, ROTATE_DECADE_BLURBS, "{decade}");
    assert.ok(SET_REQUEST_INTROS.every((line) => /Set Request/i.test(line)));
    assert.ok(SONG_REQUEST_INTROS.every((line) => /request/i.test(line)));
    assert.ok(
      ROTATE_MOOD_INTROS.some((line) => /rotat|mood|vibe/i.test(line))
    );
    assert.ok(
      ROTATE_DECADE_INTROS.some((line) => /decade|era|time/i.test(line))
    );
  });

  it("fills tokens and picks stably by salt", () => {
    assert.equal(
      fillFlavorTokens("Set Request from {guest} — {artist}", {
        guest: "Mark",
        artist: "Prince",
      }),
      "Set Request from Mark — Prince"
    );
    const a = pickFlavorAnnounceLines("rotateDecade", {
      decade: "80's",
      salt: 4,
    });
    const b = pickFlavorAnnounceLines("rotateDecade", {
      decade: "80's",
      salt: 4,
    });
    assert.equal(a.intro, b.intro);
    assert.match(a.intro, /80's/);
    assert.ok(!a.intro.includes("{decade}"));
    assert.equal(a.descriptor, "decade-rotate");
    assert.equal(pickFlavorAnnounceLines("nope"), null);
  });

  it("cleanRotationFlavor keeps mood and decade labels", () => {
    assert.equal(cleanRotationFlavor(null), null);
    assert.deepEqual(cleanRotationFlavor({ mood: "Chill", decade: "" }), {
      mood: "Chill",
      decade: null,
    });
    assert.deepEqual(cleanRotationFlavor({ decade: "80's" }), {
      mood: null,
      decade: "80's",
    });
  });
});

describe("rotation template fallback", () => {
  it("buildSetDescription names a decade rotate", () => {
    const line = buildSetDescription({
      howMany: "five",
      firstArtist: "Prince",
      rotation: { decade: "80's" },
      salt: 1,
    });
    assert.match(line, /80's/);
    assert.match(line, /rotat|decade|era/i);
    assert.match(line, /Prince/);
  });

  it("buildSetDescription names a mood rotate", () => {
    const line = buildSetDescription({
      howMany: "five",
      firstArtist: "Sade",
      rotation: { mood: "Chill" },
      salt: 2,
    });
    assert.match(line, /Chill/);
    assert.match(line, /rotat|mood|vibe/i);
  });
});

describe("writeSetScript rotation flavor", () => {
  before(() => {
    savedHaUrl = process.env.HA_URL;
    savedHaToken = process.env.HA_TOKEN;
    delete process.env.HA_URL;
    delete process.env.HA_TOKEN;
    if (fs.existsSync(HA_STORE)) fs.renameSync(HA_STORE, HA_STORE_BAK);
  });

  after(() => {
    if (savedHaUrl != null) process.env.HA_URL = savedHaUrl;
    if (savedHaToken != null) process.env.HA_TOKEN = savedHaToken;
    if (fs.existsSync(HA_STORE_BAK)) fs.renameSync(HA_STORE_BAK, HA_STORE);
  });

  beforeEach(() => {
    resetDjSetPacksForTests();
    resetDjAnnounceOrdinal();
  });

  it("uses a decade-rotate intro", async () => {
    const line = await writeSetScript({
      event: "session_refill",
      count: 5,
      highlights: [{ artist: "Prince", name: "Kiss" }],
      rotation: { decade: "80's", mood: null },
      nameIntro: false,
    });
    assert.match(line, /80's/);
    assert.match(line, /rotat|decade|era|time|year/i);
  });

  it("uses a mood-rotate intro", async () => {
    const line = await writeSetScript({
      event: "session_refill",
      count: 5,
      highlights: [{ artist: "Sade", name: "Smooth Operator" }],
      rotation: { mood: "Chill", decade: null },
      nameIntro: false,
    });
    assert.match(line, /Chill/);
    assert.match(line, /rotat|mood|vibe|wheel|dial|energy/i);
  });
});
