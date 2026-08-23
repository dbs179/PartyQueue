import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDedicationLabel,
  dedicationIsPhrased,
  dedicationSpeakLine,
  dedicationShoutInstruction,
} from "../src/dedication-label.js";
import { dedicationDisplayLabel } from "../public/js/guest.js";
import { writeRequestShoutTemplate } from "../src/party-recap.js";
import { buildRequestShoutPrompt } from "../src/dj-shout.js";
import { queueOriginBadgeHtml } from "../public/js/queue-ui.js";

test("bare names get For/From; full lines do not stack", () => {
  assert.equal(formatDedicationLabel("Mia", "Dave"), "For Mia from Dave");
  assert.equal(formatDedicationLabel("Sarah", ""), "For Sarah");
  assert.equal(
    formatDedicationLabel("To Mia from Davey", "Dave"),
    "To Mia from Davey"
  );
  assert.equal(
    formatDedicationLabel("Mia from Davey", "Dave"),
    "Mia from Davey"
  );
  assert.equal(formatDedicationLabel("For Jen", "Alex"), "For Jen from Alex");
  assert.equal(formatDedicationLabel("To Mia", "Dave"), "To Mia from Dave");
  assert.equal(
    formatDedicationLabel("For Mia from Dave", "Dave"),
    "For Mia from Dave"
  );
  assert.equal(formatDedicationLabel("", "Dave"), "");
});

test("dedicationIsPhrased detects for/to/from lines", () => {
  assert.equal(dedicationIsPhrased("Mia"), false);
  assert.equal(dedicationIsPhrased("To Mia from Davey"), true);
  assert.equal(dedicationIsPhrased("For Jen"), true);
  assert.equal(dedicationIsPhrased("going out to Sam"), true);
  assert.equal(dedicationIsPhrased("this one goes out to Sam"), true);
});

test("dedicationDisplayLabel matches the formatter", () => {
  assert.equal(
    dedicationDisplayLabel("To Mia from Davey", "Dave"),
    "To Mia from Davey"
  );
  assert.equal(dedicationDisplayLabel("Mia", "Dave"), "For Mia from Dave");
  assert.doesNotMatch(
    dedicationDisplayLabel("To Mia from Davey", "Dave"),
    /For To|from Davey from/i
  );
});

test("queue badge does not stack For/From on a phrased dedication", () => {
  const html = queueOriginBadgeHtml({
    searched: true,
    dedication: "To Mia from Davey",
    requestedBy: "Dave",
  });
  assert.match(html, /To Mia from Davey/);
  assert.doesNotMatch(html, /For To/);
  assert.doesNotMatch(html, /from Davey from/);
});

test("shout template uses phrased dedications as written", () => {
  const line = writeRequestShoutTemplate({
    name: "Come On Eileen",
    artist: "Dexys Midnight Runners",
    requestedBy: "Dave",
    dedication: "To Mia from Davey",
  });
  assert.match(line, /To Mia from Davey/);
  assert.doesNotMatch(line, /goes out to To Mia/i);
  assert.doesNotMatch(line, /For To Mia/i);
});

test("shout prompt tells the DJ not to add For/From on a phrased note", () => {
  const prompt = buildRequestShoutPrompt({
    name: "Everlong",
    artist: "Foo Fighters",
    requestedBy: "Dave",
    dedication: "To Mia from Davey",
    notes: [],
    isBirthday: false,
    birthdayLabel: "birthday star",
    djName: "DJ",
    maxWords: 55,
  });
  assert.match(prompt, /as written/);
  assert.match(prompt, /To Mia from Davey/);
  assert.doesNotMatch(prompt, /goes out to To Mia from Davey/);
  assert.match(dedicationShoutInstruction("To Mia from Davey", "Dave"), /as written/);
  assert.match(dedicationSpeakLine("To Mia from Davey", "Dave"), /To Mia from Davey\./);
});
