import { test } from "node:test";
import assert from "node:assert/strict";
import {
  djPadAheadInQueue,
  formatAddToastMessage,
  buildAddToastMessage,
} from "../public/js/add-toast.js";

test("formatAddToastMessage covers started, promoted, and position cases", () => {
  assert.equal(
    formatAddToastMessage({ name: "Thunderstruck" }, { started: true }),
    'Added "Thunderstruck" \u2014 now playing'
  );
  assert.equal(
    formatAddToastMessage(
      { name: "Song" },
      { promoted: true, queuePosition: 2 },
      true
    ),
    'Moved "Song" up \u2014 you\u2019re #2 \u00b7 after DJ'
  );
  assert.equal(
    formatAddToastMessage({ name: "Song" }, { queuePosition: 3 }),
    "Added \u2014 you\u2019re #3"
  );
  assert.equal(
    formatAddToastMessage({ name: "Song" }, {}),
    'Added "Song" to the queue'
  );
});

test("djPadAheadInQueue finds a DJ pad before the matched track", () => {
  const tracks = [
    { uri: "spotify:track:djpad", djVoice: true },
    { uri: "spotify:track:abc123", djVoice: false },
  ];
  assert.equal(djPadAheadInQueue(tracks, "spotify:track:abc123", 2), true);
  assert.equal(djPadAheadInQueue(tracks, "spotify:track:djpad", 1), false);
});

test("djPadAheadInQueue falls back to queuePosition when track not listed yet", () => {
  const tracks = [
    { uri: "spotify:track:djpad", djVoice: true },
    { uri: "spotify:track:other", djVoice: false },
  ];
  assert.equal(djPadAheadInQueue(tracks, "spotify:track:new", 2), true);
  assert.equal(djPadAheadInQueue(tracks, "spotify:track:new", 1), false);
});

test("buildAddToastMessage fetches queue and appends after DJ", async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        tracks: [
          { uri: "spotify:track:dj", djVoice: true },
          { uri: "spotify:track:hit", djVoice: false },
        ],
      };
    },
  });
  const msg = await buildAddToastMessage(
    { name: "Hit", uri: "spotify:track:hit" },
    { queuePosition: 2 },
    { fetchImpl }
  );
  assert.match(msg, /you\u2019re #2/);
  assert.match(msg, /after DJ/);
});
