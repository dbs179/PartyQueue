import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SETTINGS_FILE = path.join(
  os.tmpdir(),
  `pq-closing-time-${process.pid}-${Date.now()}.json`
);
process.env.PARTYQUEUE_SETTINGS_FILE = SETTINGS_FILE;

const {
  isEndOfNightTrack,
  isClosingTime,
  shouldAnnouncePartyRecap,
  getEndOfNightTrack,
} = await import("../src/closing-time.js");
const {
  setDjVoiceSettings,
  bustSettingsCache,
} = await import("../src/settings.js");

describe("end of night matcher", () => {
  after(() => {
    fs.rmSync(SETTINGS_FILE, { force: true });
    delete process.env.PARTYQUEUE_SETTINGS_FILE;
    bustSettingsCache();
  });

  it("defaults to Closing Time by Semisonic", () => {
    setDjVoiceSettings({
      endOfNightTrackUri: null,
      endOfNightTrackName: null,
      endOfNightTrackArtist: null,
    });
    const night = getEndOfNightTrack();
    assert.equal(night.isDefault, true);
    assert.equal(night.name, "Closing Time");
    assert.ok(
      isEndOfNightTrack({
        name: "Closing Time",
        artist: "Semisonic",
      })
    );
    assert.ok(
      isClosingTime("Closing Time", "Semisonic", null)
    );
    assert.equal(
      isEndOfNightTrack({
        name: "Closing Time",
        artist: "Tom Waits",
      }),
      false
    );
  });

  it("matches a custom Spotify URI by track id", () => {
    setDjVoiceSettings({
      endOfNightTrackUri: "spotify:track:abc123XYZ99",
      endOfNightTrackName: "Piano Man",
      endOfNightTrackArtist: "Billy Joel",
    });
    assert.equal(getEndOfNightTrack().isDefault, false);
    assert.ok(
      isEndOfNightTrack({
        uri: "spotify:track:abc123XYZ99",
        name: "Piano Man",
        artist: "Billy Joel",
      })
    );
    assert.ok(
      isEndOfNightTrack({
        uri: "spotify:track:abc123XYZ99",
        name: "Something Else",
        artist: "Whoever",
      })
    );
    assert.equal(
      isEndOfNightTrack({
        uri: "spotify:track:otherTrack01",
        name: "Closing Time",
        artist: "Semisonic",
      }),
      false
    );
  });

  it("falls back to configured name+artist when URI id missing on track", () => {
    setDjVoiceSettings({
      endOfNightTrackUri: "spotify:track:abc123XYZ99",
      endOfNightTrackName: "Piano Man",
      endOfNightTrackArtist: "Billy Joel",
    });
    assert.ok(
      isEndOfNightTrack({
        uri: null,
        name: "Piano Man",
        artist: "Billy Joel",
      })
    );
  });

  it("gates party recap TTS with djPartyRecapEnabled", () => {
    setDjVoiceSettings({ djPartyRecapEnabled: true });
    assert.equal(shouldAnnouncePartyRecap(), true);
    setDjVoiceSettings({ djPartyRecapEnabled: false });
    assert.equal(shouldAnnouncePartyRecap(), false);
  });

  it("isClosingTime stays cheap across a full playlist-sized scan", () => {
    setDjVoiceSettings({
      endOfNightTrackUri: null,
      endOfNightTrackName: null,
      endOfNightTrackArtist: null,
    });
    const started = Date.now();
    let hits = 0;
    for (let i = 0; i < 10_000; i++) {
      if (isClosingTime(`Song ${i}`, `Artist ${i}`, `spotify:track:${i}`)) {
        hits += 1;
      }
    }
    const elapsed = Date.now() - started;
    assert.equal(hits, 0);
    // Regression guard: previously called getDjVoiceSettings (icon migrations)
    // per track and took ~10s+ for a ~9k pool scan on Random.
    assert.ok(elapsed < 500, `expected <500ms, took ${elapsed}ms`);
  });
});
