import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SISTER_STATIC_TAGLINES,
  SISTER_STATIC_BIBLE,
  SISTER_STATIC_NAME,
  sisterStaticNameIntrosFor,
  buildSisterStaticPunchlinePrompt,
  BANTER_PUNCHLINE_MAX_WORDS,
} from "../src/dj-sister-static.js";
import { DJ_TAGLINES } from "../src/dj-taglines.js";
import { buildRequestShoutPrompt } from "../src/dj-shout.js";
import { DJ_PERSONA_SISTER_STATIC } from "../src/settings.js";

test("Sister Static tagline pack is 50 short unique lines", () => {
  assert.equal(SISTER_STATIC_TAGLINES.length, 50);
  const seen = new Set();
  for (const line of SISTER_STATIC_TAGLINES) {
    assert.ok(line && typeof line === "string", "tagline required");
    assert.ok(line.length <= 60, `tagline too long: ${line}`);
    assert.ok(!seen.has(line), `duplicate tagline: ${line}`);
    seen.add(line);
  }
  for (const line of DJ_TAGLINES) {
    assert.equal(seen.has(line), false, `shared tagline with Holy Roller: ${line}`);
  }
});

test("Sister Static bible and name intros stay off the Holy Roller path", () => {
  assert.match(SISTER_STATIC_BIBLE.identity, /Sister Static/);
  assert.match(SISTER_STATIC_BIBLE.identity, /Holy Roller/);
  const intros = sisterStaticNameIntrosFor(SISTER_STATIC_NAME);
  assert.ok(intros.length >= 4);
  for (const line of intros) {
    assert.doesNotMatch(line, /your boy/i);
    assert.match(line, /Sister Static/);
  }
});

test("punchline prompt reacts to Holy Roller's script and caps length", () => {
  const prompt = buildSisterStaticPunchlinePrompt(
    "Holy Roller here with four heaters from the pulpit.",
    { event: "Church Night" }
  );
  assert.match(prompt, /four heaters from the pulpit/);
  assert.match(prompt, /do not repeat/i);
  assert.match(prompt, new RegExp(String(BANTER_PUNCHLINE_MAX_WORDS)));
  assert.doesNotMatch(prompt, /your boy/i);
});

test("Sister Static shout prompt skips mean birthday song-choice piles-on", () => {
  const prompt = buildRequestShoutPrompt({
    name: "Baby Shark",
    artist: "Pinkfong",
    requestedBy: "Sam",
    isBirthday: true,
    birthdayLabel: "birthday star",
    djName: "Sister Static",
    maxWords: 45,
    notes: [],
    djSettings: { id: DJ_PERSONA_SISTER_STATIC },
  });
  assert.match(prompt, /co-host/i);
  assert.match(prompt, /embarrass/i);
  assert.match(prompt, /song choice/i);
  assert.doesNotMatch(prompt, /lively party DJ/i);
});
