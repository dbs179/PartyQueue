import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeGuestBlurb } from "../src/guest-profiles.js";
import { writeRequestShoutTemplate } from "../src/party-recap.js";
import { buildRequestShoutPrompt } from "../src/dj-shout.js";

test("attributeGuestBlurb rewrites first-person notes about the guest", () => {
  assert.equal(
    attributeGuestBlurb("I love bourbon", "Dave"),
    "Dave loves bourbon"
  );
  assert.equal(
    attributeGuestBlurb("I'm always dancing", "Maria"),
    "Maria is always dancing"
  );
  assert.equal(
    attributeGuestBlurb("I've got a dog named Gypsy", "Jen"),
    "Jen has a dog named Gypsy"
  );
  assert.equal(
    attributeGuestBlurb("I'll drink to that", "Dave"),
    "Dave will drink to that"
  );
  assert.equal(
    attributeGuestBlurb("My spirit animal is a raccoon", "Mark"),
    "Mark's spirit animal is a raccoon"
  );
  assert.equal(
    attributeGuestBlurb("I always bring crayons", "Mark"),
    "Mark always brings crayons"
  );
  assert.equal(
    attributeGuestBlurb("I love bourbon and I love karaoke", "Dave"),
    "Dave loves bourbon and Dave loves karaoke"
  );
  assert.equal(
    attributeGuestBlurb("I don't skip the slow songs", "Casey"),
    "Casey doesn't skip the slow songs"
  );
});

test("attributeGuestBlurb prefixes fragments and leaves named notes alone", () => {
  assert.equal(
    attributeGuestBlurb("Likes karaoke", "Dave"),
    "Dave likes karaoke"
  );
  assert.equal(
    attributeGuestBlurb("a bourbon guy", "Dave"),
    "Dave is a bourbon guy"
  );
  assert.equal(
    attributeGuestBlurb("Dave loves bourbon", "Dave"),
    "Dave loves bourbon"
  );
  assert.equal(attributeGuestBlurb("I love bourbon", ""), "I love bourbon");
  assert.equal(attributeGuestBlurb("", "Dave"), "");
});

test("template shout speaks first-person notes as the guest", () => {
  const line = writeRequestShoutTemplate({
    name: "Come On Eileen",
    artist: "Dexys Midnight Runners",
    requestedBy: "Dave",
    notes: ["I love bourbon"],
  });
  assert.match(line, /Dave loves bourbon/i);
  assert.doesNotMatch(line, /\bI love bourbon\b/i);
});

test("shout prompt tells the DJ blurbs are about the guest, not I", () => {
  const prompt = buildRequestShoutPrompt({
    name: "Everlong",
    artist: "Foo Fighters",
    requestedBy: "Dave",
    notes: ["I love bourbon"],
    isBirthday: false,
    birthdayLabel: "birthday star",
    djName: "DJ",
    maxWords: 55,
  });
  assert.match(prompt, /talking ABOUT Dave/);
  assert.match(prompt, /Dave loves bourbon/);
  assert.match(prompt, /1\. Dave loves bourbon/);
  assert.doesNotMatch(prompt, /1\. I love bourbon/);
  assert.match(prompt, /third person, never "I"/);
});
