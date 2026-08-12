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
      { uri: uri("aaa"), name: "A1", artist: "X" },
      { uri: uri("bbb"), name: "B", artist: "Y" },
      { uri: uri("aaa"), name: "A2", artist: "X" },
      { uri: uri("ccc"), name: "C", artist: "Z" },
    ],
    []
  );
  assert.deepEqual(
    out.map((t) => t.name),
    ["A1", "B", "C"]
  );
});

test("filterSetRequestTracks drops same song under different Spotify ids", () => {
  const out = filterSetRequestTracks(
    [
      {
        uri: uri("1YYhDizHx7PnDhAhko6cDS"),
        name: "Take Me Home, Country Roads - Original Version",
        artist: "John Denver",
      },
      {
        uri: uri("1QbOvACeYanja5pbnJbAmk"),
        name: "Take Me Home, Country Roads",
        artist: "John Denver",
      },
      {
        uri: uri("4J0DbyODwZJcmIAiTSJfMF"),
        name: "Annie's Song",
        artist: "John Denver",
      },
      {
        uri: uri("1ne9wOtDF2jM6Cm8WBkaER"),
        name: "Rocky Mountain High",
        artist: "John Denver",
      },
      {
        uri: uri("69HICMmc6nNLucAx3aJX9M"),
        name: "Thank God I'm a Country Boy",
        artist: "John Denver",
      },
      {
        uri: uri("extra6"),
        name: "Leaving on a Jet Plane",
        artist: "John Denver",
      },
    ],
    []
  );
  assert.deepEqual(
    out.map((t) => t.name),
    [
      "Take Me Home, Country Roads - Original Version",
      "Annie's Song",
      "Rocky Mountain High",
      "Thank God I'm a Country Boy",
      "Leaving on a Jet Plane",
    ]
  );
});

test("filterSetRequestTracks skips upcoming songs matched by song key", () => {
  const out = filterSetRequestTracks(
    [
      {
        uri: uri("1QbOvACeYanja5pbnJbAmk"),
        name: "Take Me Home, Country Roads",
        artist: "John Denver",
      },
      {
        uri: uri("4J0DbyODwZJcmIAiTSJfMF"),
        name: "Annie's Song",
        artist: "John Denver",
      },
    ],
    new Set(),
    SET_REQUEST_SIZE,
    new Set(["take me home country roads|john denver"])
  );
  assert.deepEqual(
    out.map((t) => t.name),
    ["Annie's Song"]
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
