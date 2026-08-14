import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nowPlayingOriginLabel,
  displayOriginLabel,
  displayOriginTone,
} from "../public/js/now-playing-origin.js";

test("nowPlayingOriginLabel returns null without a track or for DJ clips", () => {
  assert.equal(nowPlayingOriginLabel(null, false), null);
  assert.equal(nowPlayingOriginLabel({ title: "X", djVoice: true }, true), null);
});

test("nowPlayingOriginLabel covers Discover, Requested, and Random", () => {
  assert.deepEqual(nowPlayingOriginLabel({ origin: "discovered" }, true), {
    text: "Discover",
    title: "Added by Discover (similar to your music)",
    cls: "origin-discovered",
  });
  assert.deepEqual(
    nowPlayingOriginLabel(
      { origin: "searched", requestedBy: "Dave" },
      true
    ),
    {
      text: "Requested · Dave",
      title: "Requested by Dave",
      cls: "origin-searched",
    }
  );
  assert.equal(
    nowPlayingOriginLabel({ origin: "filler" }, true).text,
    "Random"
  );
  assert.equal(
    nowPlayingOriginLabel({ origin: "filler", reactionSet: "loved" }, true)
      .text,
    "Most Loved"
  );
  assert.equal(
    nowPlayingOriginLabel({ origin: "filler", reactionSet: "hated" }, true)
      .cls,
    "origin-hated"
  );
  assert.equal(
    nowPlayingOriginLabel({ origin: "filler", reactionSet: "requested" }, true)
      .text,
    "Most Requested"
  );
});

test("nowPlayingOriginLabel prefers dedication text for searched tracks", () => {
  const label = nowPlayingOriginLabel(
    {
      searched: true,
      dedication: "Sarah",
      requestedBy: "Mark",
    },
    true
  );
  assert.equal(label.cls, "origin-searched");
  assert.match(label.text, /Sarah/);
  assert.match(label.text, /Mark/);
});

test("displayOriginLabel precedence: dedication > requested > era > discover > random", () => {
  assert.match(
    displayOriginLabel({
      dedication: "Ann",
      requestedBy: "Bob",
      searched: true,
    }),
    /Ann/
  );
  assert.equal(
    displayOriginLabel({ searched: true, requestedBy: "Dave" }),
    "Requested by Dave"
  );
  assert.equal(
    displayOriginLabel({ moodPick: true, mood: "80s" }, "80s"),
    "80's Hit"
  );
  assert.equal(displayOriginLabel({ discovered: true }), "Discover");
  assert.equal(displayOriginLabel({}), "Random");
});

test("displayOriginTone matches Requested / Discover / Random / Mood", () => {
  assert.equal(
    displayOriginTone({ searched: true, requestedBy: "Dave" }),
    "origin-searched"
  );
  assert.equal(
    displayOriginTone({ discovered: true }),
    "origin-discovered"
  );
  assert.equal(displayOriginTone({ origin: "filler" }), "origin-random");
  assert.equal(
    displayOriginTone({ moodPick: true, mood: "80s" }),
    "origin-mood"
  );
  assert.equal(displayOriginTone({}), "origin-random");
});
