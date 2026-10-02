// Holiday chip persistence: exclusive with a decade, and cleared when the
// date leaves every holiday window.

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
  autofill.savePickerSelection(undefined, undefined, null, false);
  delete process.env.PARTYQUEUE_HOLIDAY_NOW;
  fs.rmSync(STORE, { recursive: true, force: true });
  delete process.env.PARTYQUEUE_SETTINGS_FILE;
  settings?.bustSettingsCache();
});

beforeEach(() => {
  process.env.PARTYQUEUE_HOLIDAY_NOW = "2026-10-02T12:00:00";
  if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
  settings.bustSettingsCache();
  settings.saveSettings({});
  settings.bustSettingsCache();
  autofill.savePickerSelection(undefined, undefined, null, false);
});

test("turning Holiday on clears the decade", () => {
  autofill.savePickerSelection(undefined, undefined, "80s", false);
  const on = autofill.savePickerSelection(undefined, undefined, null, true);
  assert.equal(on.holidayMode, true);
  assert.equal(on.mood, null);
  settings.bustSettingsCache();
  assert.equal(settings.loadSettings().holidayMode, true);
  assert.equal(settings.loadSettings().mood, null);
});

test("turning a decade on clears Holiday", () => {
  autofill.savePickerSelection(undefined, undefined, null, true);
  const decade = autofill.savePickerSelection(undefined, undefined, "90s", false);
  assert.equal(decade.mood, "90s");
  assert.equal(decade.holidayMode, false);
});

test("Holiday left on past the window clears on the next read", () => {
  autofill.savePickerSelection(undefined, undefined, null, true);
  assert.equal(autofill.getAutoFillState().holidayMode, true);
  const nov1 = new Date(2026, 10, 1, 12);
  const read = autofill.readHolidaySelection(nov1);
  assert.equal(read.cleared, true);
  assert.equal(read.holidayMode, false);
  assert.equal(read.holidayLabel, null);
  assert.equal(autofill.getAutoFillState().holidayMode, false);
  settings.bustSettingsCache();
  assert.equal(settings.loadSettings().holidayMode, false);
});

test("Kids Lock suspends Holiday and restores it", async () => {
  const rituals = await import("../src/party-rituals.js");
  autofill.savePickerSelection(undefined, ["rock"], null, true);
  rituals.setKidsLock(true);
  assert.equal(autofill.getAutoFillState().holidayMode, false);
  assert.deepEqual(autofill.getAutoFillState().genres, ["kids", "soundtrack"]);
  rituals.setKidsLock(false);
  assert.equal(autofill.getAutoFillState().holidayMode, true);
  assert.deepEqual(autofill.getAutoFillState().genres, ["rock"]);
});

test("DJ era slot names the active holiday", async () => {
  const dj = await import("../src/dj-voice.js");
  autofill.savePickerSelection(undefined, ["rock"], null, true);
  const ctx = dj.resolveDjMoodContext({ genres: ["rock"], eraMood: "80s" });
  assert.equal(ctx.eraLabel, "Halloween");
});

test("in-season read keeps Holiday on and names Halloween", () => {
  autofill.savePickerSelection(undefined, undefined, null, true);
  const oct2 = new Date(2026, 9, 2, 12);
  const read = autofill.readHolidaySelection(oct2);
  assert.equal(read.cleared, false);
  assert.equal(read.holidayMode, true);
  assert.equal(read.holidayLabel, "Halloween");
  assert.equal(read.holidayId, "halloween");
});
