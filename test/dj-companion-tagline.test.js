import { test } from "node:test";
import assert from "node:assert/strict";
import { findCompanionDjTtsUri } from "../src/sonos.js";

const ramp = {
  TrackUri: "http://10.10.1.30:8088/media/tts/silence-ramp-3s.mp3",
  Title: "PartyQueue Volume Ramp",
};
const tts = {
  TrackUri: "http://ha.local:8123/api/tts_proxy/abc123.mp3",
  Title: "tts",
};
const restore = {
  TrackUri: "http://10.10.1.30:8088/media/tts/silence-3s.mp3",
  Title: "PartyQueue Silence Bridge",
};
const song = {
  TrackUri: "spotify:track:abc",
  Title: "Hurt",
};

test("ramp silence resolves forward to the TTS companion", () => {
  const items = [song, ramp, tts, restore, song];
  assert.equal(findCompanionDjTtsUri(items, 1), tts.TrackUri);
});

test("restore silence resolves backward to the TTS companion", () => {
  const items = [ramp, tts, restore, song];
  assert.equal(findCompanionDjTtsUri(items, 2), tts.TrackUri);
});

test("returns null when no TTS sits next to the pad", () => {
  assert.equal(findCompanionDjTtsUri([ramp, song], 0), null);
  assert.equal(findCompanionDjTtsUri([], 0), null);
});
