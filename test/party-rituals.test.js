import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STORE = path.join(
  os.tmpdir(),
  `pq-party-rituals-${process.pid}-${Date.now()}.json`
);
process.env.PARTYQUEUE_SETTINGS_FILE = STORE;

let settings;
let rituals;

before(async () => {
  settings = await import("../src/settings.js");
  settings.bustSettingsCache();
  // Import autofill after settings so Kids lock can update picker genres.
  await import("../src/autofill.js");
  rituals = await import("../src/party-rituals.js");
});

after(() => {
  fs.rmSync(STORE, { recursive: true, force: true });
  delete process.env.PARTYQUEUE_SETTINGS_FILE;
  settings?.bustSettingsCache();
});

beforeEach(() => {
  if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
  settings.bustSettingsCache();
  settings.saveSettings({
    genres: ["party", "rock"],
    djCharacterIntensity: "extra",
    filterExplicit: false,
    requestsPaused: false,
    kidsLock: false,
    kidsLockSnapshot: null,
  });
  settings.bustSettingsCache();
});

test("setRequestsPaused toggles the content flag", () => {
  assert.equal(rituals.setRequestsPaused(true).requestsPaused, true);
  assert.equal(settings.getContentSettings().requestsPaused, true);
  assert.equal(rituals.setRequestsPaused(false).requestsPaused, false);
});

test("host-only controls are opt-in and persist independently", () => {
  assert.equal(settings.getContentSettings().hostControlsOnly, false);
  assert.equal(
    settings.setContentSettings({ hostControlsOnly: true }).hostControlsOnly,
    true
  );
  assert.equal(settings.getContentSettings().requestsPaused, false);
});

test("setKidsLock pins Kids mood + subtle DJ and restores on unlock", () => {
  settings.setDjVoiceSettings({
    djSisterStatic: { djCharacterIntensity: "extra" },
  });
  const on = rituals.setKidsLock(true);
  assert.equal(on.kidsLock, true);
  assert.deepEqual(on.genres, ["kids", "soundtrack"]);
  assert.equal(on.djCharacterIntensity, "subtle");
  assert.equal(on.filterExplicit, true);
  assert.equal(
    settings.getDjPersona("sister-static").djCharacterIntensity,
    "subtle"
  );

  const off = rituals.setKidsLock(false);
  assert.equal(off.kidsLock, false);
  assert.deepEqual(off.genres, ["party", "rock"]);
  assert.equal(off.djCharacterIntensity, "extra");
  assert.equal(off.filterExplicit, false);
  assert.equal(
    settings.getDjPersona("sister-static").djCharacterIntensity,
    "extra"
  );
});
