import { test } from "node:test";
import assert from "node:assert/strict";
import { writeRequestShoutTemplate } from "../src/party-recap.js";

test("request shout template mentions dedication", () => {
  const line = writeRequestShoutTemplate({
    name: "Come On Eileen",
    artist: "Dexys Midnight Runners",
    requestedBy: "Mark",
    dedication: "Sarah",
  });
  assert.match(line, /Mark/i);
  assert.match(line, /Sarah/i);
  assert.match(line, /goes out to|Dedicated to|Going out to/i);
  assert.match(line, /Come On Eileen/i);
});

test("set-request template names the Set Request and artist", () => {
  const line = writeRequestShoutTemplate({
    name: "Everlong",
    artist: "Foo Fighters",
    requestedBy: "Mark",
    kind: "setRequest",
    trackCount: 5,
  });
  assert.match(line, /Set Request/i);
  assert.match(line, /Mark/i);
  assert.match(line, /Foo Fighters/i);
  assert.doesNotMatch(line, /Random/i);
});

test("song-request template frames a single request", () => {
  const line = writeRequestShoutTemplate({
    name: "Everlong",
    artist: "Foo Fighters",
    requestedBy: "Mark",
    kind: "songRequest",
  });
  assert.match(line, /request/i);
  assert.match(line, /Mark/i);
  assert.match(line, /Everlong/i);
  assert.doesNotMatch(line, /Set Request/i);
});

test("request shout template omits dedication when unset", () => {
  const line = writeRequestShoutTemplate({
    name: "Come On Eileen",
    artist: "Dexys Midnight Runners",
    requestedBy: "Mark",
  });
  assert.doesNotMatch(line, /goes out to|Dedicated to|Going out to/i);
});
