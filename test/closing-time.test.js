import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  isEndOfNightTrack,
  isClosingTime,
  shouldAnnouncePartyRecap,
  getEndOfNightTrack,
} from "../src/closing-time.js";
import {
  getDjVoiceSettings,
  setDjVoiceSettings,
  bustSettingsCache,
} from "../src/settings.js";

describe("end of night matcher", () => {
  let prev;

  before(() => {
    prev = getDjVoiceSettings();
  });

  after(() => {
    setDjVoiceSettings({
      endOfNightTrackUri: prev.endOfNightTrackUri,
      endOfNightTrackName: prev.endOfNightTrackName,
      endOfNightTrackArtist: prev.endOfNightTrackArtist,
      djPartyRecapEnabled: prev.djPartyRecapEnabled,
    });
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
});
