import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SISTER_STATIC_TAGLINES,
  SISTER_STATIC_BIBLE,
  SISTER_STATIC_NAME,
  SISTER_STATIC_BOOTH_ASIDES,
  sisterStaticNameIntrosFor,
  buildSisterStaticPunchlinePrompt,
  formatSisterStaticPunchlineSetContext,
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
  assert.match(SISTER_STATIC_BIBLE.identity, /female/);
  assert.match(SISTER_STATIC_BIBLE.identity, /sidekick/i);
  assert.ok(
    SISTER_STATIC_BIBLE.quirks.some((q) => /not a second hype DJ/i.test(q))
  );
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

test("punchline prompt includes this-block set context", () => {
  const context = formatSisterStaticPunchlineSetContext({
    count: 6,
    highlights: [{ artist: "Prince", name: "Kiss" }],
    reactionSet: { kind: "loved" },
  });
  assert.match(context, /Song count: 6/);
  assert.match(context, /Kiss by Prince/);
  assert.match(context, /most loved/);
  const prompt = buildSisterStaticPunchlinePrompt("Four heaters from the pulpit.", {
    event: "Church Night",
    setContext: {
      count: 6,
      highlights: [{ artist: "Prince", name: "Kiss" }],
      reactionSet: { kind: "loved" },
    },
  });
  assert.match(prompt, /aim the joke/);
  assert.match(prompt, /most loved/);
  assert.match(prompt, /Kiss by Prince/);
});

test("Sister Static booth asides are her own pack", () => {
  assert.equal(SISTER_STATIC_BOOTH_ASIDES.length, 50);
  const seen = new Set();
  for (const entry of SISTER_STATIC_BOOTH_ASIDES) {
    assert.match(entry.id, /^ss-aside-\d+$/);
    assert.ok(entry.text && entry.text.length < 90, entry.text);
    assert.equal(typeof entry.familySafe, "boolean");
    assert.ok(!seen.has(entry.text), entry.text);
    seen.add(entry.text);
    assert.doesNotMatch(entry.text, /your boy/i);
    assert.doesNotMatch(entry.text, /\bbeer\b/i);
    assert.doesNotMatch(entry.text, /second hype/i);
    assert.doesNotMatch(entry.text, /somebody has to be the adult/i);
  }
  assert.ok(SISTER_STATIC_BOOTH_ASIDES.some((e) => e.familySafe));
  assert.ok(SISTER_STATIC_BOOTH_ASIDES.some((e) => !e.familySafe));
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
