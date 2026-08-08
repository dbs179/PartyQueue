import { test } from "node:test";
import assert from "node:assert/strict";
import {
  trackIdFromUri,
  songMatchKey,
  buildQueuedPresence,
  isTrackQueued,
  queuedResultBadge,
} from "../public/js/search-track.js";

test("trackIdFromUri extracts Spotify ids from Sonos URIs", () => {
  assert.equal(
    trackIdFromUri(
      "x-sonos-spotify:spotify:track:3WMj8moIAXJhHsyLaqIIHI?sid=12"
    ),
    "3WMj8moIAXJhHsyLaqIIHI"
  );
  assert.equal(trackIdFromUri("spotify:track:abc123"), "abc123");
  assert.equal(trackIdFromUri(""), null);
});

test("songMatchKey matches across case and release differences", () => {
  assert.equal(
    songMatchKey("If It Means a Lot to You", "A Day to Remember"),
    songMatchKey("If It Means A Lot To You", "A Day To Remember")
  );
  const base = songMatchKey("Comfortably Numb", "Pink Floyd");
  assert.equal(songMatchKey("Comfortably Numb - Live", "Pink Floyd"), base);
  assert.equal(
    songMatchKey("Comfortably Numb (Remastered 2011)", "Pink Floyd"),
    base
  );
});

test("buildQueuedPresence splits searched vs filler", () => {
  const presence = buildQueuedPresence([
    {
      uri: "spotify:track:aaa",
      title: "A",
      artist: "Artist",
      searched: true,
    },
    {
      uri: "spotify:track:bbb",
      title: "B",
      artist: "Artist",
      searched: false,
    },
  ]);
  assert.ok(presence.queuedIds.has("aaa"));
  assert.ok(presence.queuedIds.has("bbb"));
  assert.ok(presence.searchedQueuedIds.has("aaa"));
  assert.equal(presence.searchedQueuedIds.has("bbb"), false);
});

test("queuedResultBadge distinguishes Random vs guest queue", () => {
  const presence = {
    ...buildQueuedPresence([
      {
        uri: "spotify:track:rand1",
        title: "Dice",
        artist: "Band",
        searched: false,
      },
      {
        uri: "spotify:track:req1",
        title: "Hello",
        artist: "Adele",
        searched: true,
      },
    ]),
    nowPlayingId: null,
    nowPlayingKey: "",
  };
  const random = queuedResultBadge("rand1", songMatchKey("Dice", "Band"), presence);
  assert.equal(random.isRandom, true);
  assert.match(random.label, /Random/);
  const guest = queuedResultBadge("req1", songMatchKey("Hello", "Adele"), presence);
  assert.equal(guest.isRandom, false);
  assert.equal(isTrackQueued("missing", "", presence), false);
});
