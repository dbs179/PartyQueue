import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterSetRequestTracks,
  SET_REQUEST_SIZE,
} from "../src/sonos-queue-mutations.js";

const uri = (id) => `spotify:track:${id}`;

test("filterSetRequestTracks drops duplicate Spotify ids in one payload", () => {
  const out = filterSetRequestTracks(
    [
      { uri: uri("aaa"), name: "A1" },
      { uri: uri("bbb"), name: "B" },
      { uri: uri("aaa"), name: "A2" },
      { uri: uri("ccc"), name: "C" },
    ],
    []
  );
  assert.deepEqual(
    out.map((t) => t.name),
    ["A1", "B", "C"]
  );
});

test("filterSetRequestTracks skips ids already upcoming", () => {
  const out = filterSetRequestTracks(
    [
      { uri: uri("aaa"), name: "A" },
      { uri: uri("bbb"), name: "B" },
    ],
    new Set(["aaa"])
  );
  assert.deepEqual(
    out.map((t) => spotifyId(t.uri)),
    ["bbb"]
  );
});

test("filterSetRequestTracks respects the set size cap", () => {
  const tracks = Array.from({ length: 8 }, (_, i) => ({
    uri: uri(`id${i}`),
    name: `S${i}`,
  }));
  const out = filterSetRequestTracks(tracks, [], SET_REQUEST_SIZE);
  assert.equal(out.length, SET_REQUEST_SIZE);
  assert.equal(out[0].name, "S0");
  assert.equal(out[SET_REQUEST_SIZE - 1].name, `S${SET_REQUEST_SIZE - 1}`);
});

test("filterSetRequestTracks ignores invalid uris", () => {
  assert.deepEqual(
    filterSetRequestTracks(
      [{ uri: "http://not-spotify" }, null, { uri: uri("ok"), name: "OK" }],
      []
    ).map((t) => t.name),
    ["OK"]
  );
});

function spotifyId(value) {
  return String(value).split(":").pop();
}
