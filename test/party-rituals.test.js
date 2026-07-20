import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(__dirname, "..", "data", "settings.json");
const BAK = STORE + ".p3ritualbak";

let settings;
let rituals;

before(async () => {
  if (fs.existsSync(STORE)) fs.renameSync(STORE, BAK);
  else if (fs.existsSync(BAK)) fs.unlinkSync(BAK);
  settings = await import("../src/settings.js");
  settings.bustSettingsCache();
  // Import autofill after settings so Kids lock can update picker genres.
  await import("../src/autofill.js");
  rituals = await import("../src/party-rituals.js");
});

after(() => {
  if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
  if (fs.existsSync(BAK)) fs.renameSync(BAK, STORE);
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

test("setKidsLock pins Kids mood + subtle DJ and restores on unlock", () => {
  const on = rituals.setKidsLock(true);
  assert.equal(on.kidsLock, true);
  assert.deepEqual(on.genres, ["kids", "soundtrack"]);
  assert.equal(on.djCharacterIntensity, "subtle");
  assert.equal(on.filterExplicit, true);

  const off = rituals.setKidsLock(false);
  assert.equal(off.kidsLock, false);
  assert.deepEqual(off.genres, ["party", "rock"]);
  assert.equal(off.djCharacterIntensity, "extra");
  assert.equal(off.filterExplicit, false);
});
