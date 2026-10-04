// Mood holiday chips: the host picks the playlist. A decade clears it, and
// the date does not.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STORE = path.join(
  os.tmpdir(),
  `pq-holiday-mode-${process.pid}-${Date.now()}.json`
);
process.env.PARTYQUEUE_SETTINGS_FILE = STORE;

let settings;
let autofill;

before(async () => {
  settings = await import("../src/settings.js");
  autofill = await import("../src/autofill.js");
});

after(() => {
  autofill.savePickerSelection(undefined, undefined, null, null);
  fs.rmSync(STORE, { recursive: true, force: true });
  delete process.env.PARTYQUEUE_SETTINGS_FILE;
  settings?.bustSettingsCache();
});

beforeEach(() => {
  if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
  settings.bustSettingsCache();
  settings.saveSettings({});
  settings.bustSettingsCache();
  autofill.savePickerSelection(undefined, undefined, null, null, []);
});

test("a holiday chip clears the decade and names that playlist", () => {
  autofill.savePickerSelection(undefined, undefined, "80s", null);
  const on = autofill.savePickerSelection(undefined, undefined, null, "halloween");
  assert.equal(on.holidayMode, true);
  assert.equal(on.holidayId, "halloween");
  assert.equal(on.mood, null);
  settings.bustSettingsCache();
  assert.equal(settings.loadSettings().holidayId, "halloween");
  assert.equal(settings.loadSettings().mood, null);
  const read = autofill.readHolidaySelection();
  assert.equal(read.holidayLabel, "Halloween");
});

test("Christmas stays selected outside its date window", () => {
  autofill.savePickerSelection(undefined, undefined, null, "christmas");
  const read = autofill.readHolidaySelection();
  assert.equal(read.holidayId, "christmas");
  assert.equal(read.holidayLabel, "Christmas");
  assert.equal(read.cleared, false);
});

test("Independence Day and New Years are selectable chips", () => {
  const july = autofill.savePickerSelection(undefined, undefined, null, "july4");
  assert.equal(july.holidayId, "july4");
  assert.equal(autofill.readHolidaySelection().holidayLabel, "Independence Day");
  const nye = autofill.savePickerSelection(undefined, undefined, null, "newyears");
  assert.equal(nye.holidayId, "newyears");
  assert.equal(autofill.readHolidaySelection().holidayLabel, "New Years");
});

test("a holiday that has no chip is ignored", () => {
  const saved = autofill.savePickerSelection(undefined, undefined, null, "easter");
  assert.equal(saved.holidayId, null);
  assert.equal(saved.holidayMode, false);
});

test("turning a decade on clears the holiday chip", () => {
  autofill.savePickerSelection(undefined, undefined, null, "halloween");
  const decade = autofill.savePickerSelection(undefined, undefined, "90s", null);
  assert.equal(decade.mood, "90s");
  assert.equal(decade.holidayMode, false);
  assert.equal(decade.holidayId, null);
});

test("holiday playlist checks are remembered and kids lock leaves them alone", async () => {
  autofill.savePickerSelection(
    ["party", "halloween-a"],
    ["rock"],
    null,
    "halloween",
    ["halloween-a"]
  );
  assert.deepEqual(autofill.getAutoFillState().holidayAutoPlaylistIds, [
    "halloween-a",
  ]);
  const rituals = await import("../src/party-rituals.js");
  rituals.setKidsLock(true);
  assert.equal(autofill.getAutoFillState().holidayId, null);
  assert.deepEqual(autofill.getAutoFillState().playlistIds, [
    "party",
    "halloween-a",
  ]);
  assert.deepEqual(autofill.getAutoFillState().holidayAutoPlaylistIds, [
    "halloween-a",
  ]);
  rituals.setKidsLock(false);
  assert.equal(autofill.getAutoFillState().holidayId, "halloween");
  assert.deepEqual(autofill.getAutoFillState().holidayAutoPlaylistIds, [
    "halloween-a",
  ]);
  const cleared = autofill.savePickerSelection(
    ["party"],
    ["rock"],
    null,
    null,
    []
  );
  assert.deepEqual(cleared.playlistIds, ["party"]);
  assert.deepEqual(cleared.holidayAutoPlaylistIds, []);
});

test("Kids Lock suspends the holiday chip and restores it", async () => {
  const rituals = await import("../src/party-rituals.js");
  autofill.savePickerSelection(undefined, ["rock"], null, "christmas");
  rituals.setKidsLock(true);
  assert.equal(autofill.getAutoFillState().holidayId, null);
  assert.deepEqual(autofill.getAutoFillState().genres, ["kids", "soundtrack"]);
  rituals.setKidsLock(false);
  assert.equal(autofill.getAutoFillState().holidayId, "christmas");
  assert.deepEqual(autofill.getAutoFillState().genres, ["rock"]);
});

test("DJ era slot names the selected holiday", async () => {
  const dj = await import("../src/dj-voice.js");
  autofill.savePickerSelection(undefined, ["rock"], null, "newyears");
  const ctx = dj.resolveDjMoodContext({ genres: ["rock"], eraMood: "80s" });
  assert.equal(ctx.eraLabel, "New Years");
});
