import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SAME_ARTIST_BLURBS,
  SAME_ARTIST_INTROS,
  cleanSameArtistBatch,
  fillArtistTemplate,
  pickSameArtistAnnounceLines,
} from "../src/dj-same-artist-announce.js";
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

describe("same-artist announce bank", () => {
  it("has 30 intros and 30 blurbs with {artist}", () => {
    assert.equal(SAME_ARTIST_INTROS.length, 30);
    assert.equal(SAME_ARTIST_BLURBS.length, 30);
    assert.ok(SAME_ARTIST_INTROS.every((line) => line.includes("{artist}")));
    assert.ok(SAME_ARTIST_BLURBS.every((line) => line.includes("{artist}")));
    assert.ok(
      SAME_ARTIST_INTROS.some((line) => /same-artist|one-artist|showcase/i.test(line))
    );
  });

  it("fills artist tokens and picks stably by salt", () => {
    assert.equal(
      fillArtistTemplate("all {artist}", "Foo Fighters"),
      "all Foo Fighters"
    );
    const a = pickSameArtistAnnounceLines({ artist: "Foo Fighters", salt: 3 });
    const b = pickSameArtistAnnounceLines({ artist: "Foo Fighters", salt: 3 });
    assert.equal(a.intro, b.intro);
    assert.equal(a.blurb, b.blurb);
    assert.match(a.intro, /Foo Fighters/);
    assert.match(a.blurb, /Foo Fighters/);
    assert.equal(a.descriptor, "same-artist");
    assert.ok(!a.intro.includes("{artist}"));
  });

  it("cleanSameArtistBatch reads artist/key", () => {
    assert.equal(cleanSameArtistBatch(null), null);
    assert.deepEqual(cleanSameArtistBatch({ artist: "Foo Fighters", key: "foo fighters" }), {
      artist: "Foo Fighters",
      key: "foo fighters",
    });
  });
});

describe("same-artist template fallback", () => {
  it("buildSetDescription names the showcase artist", () => {
    const line = buildSetDescription({
      howMany: "five",
      firstArtist: "Foo Fighters",
      sameArtistName: "Foo Fighters",
      salt: 1,
    });
    assert.match(line, /same-artist|one-artist|one name/i);
    assert.match(line, /Foo Fighters/);
  });
});

describe("writeSetScript same-artist flavor", () => {
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

  it("uses a same-artist intro when the batch is a showcase", async () => {
    const line = await writeSetScript({
      event: "session_refill",
      count: 5,
      highlights: [{ artist: "Foo Fighters", name: "Run" }],
      sameArtistBatch: { artist: "Foo Fighters", key: "foo fighters" },
      nameIntro: false,
    });
    assert.match(line, /Foo Fighters/);
    assert.match(line, /same-artist|one-artist|showcase|mini-set|one name|one catalog|deep dive/i);
  });
});
