// Random Mood / Random Decade rotation between Never-Ending sets:
// cadence counting, no-immediate-repeat, small-pool skip, Kids Lock
// suspension, and persistence through savePickerSelection.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STORE = path.join(
  os.tmpdir(),
  `pq-rotation-${process.pid}-${Date.now()}.json`
);
process.env.PARTYQUEUE_SETTINGS_FILE = STORE;

let settings;
let autofill;
let presets;

// Guardrail probe stub: a roomy pool so the re-roll never triggers unless a
// test wants it to.
const bigPool = async () => ({ tracks: 999, playlists: 9 });

before(async () => {
  settings = await import("../src/settings.js");
  autofill = await import("../src/autofill.js");
  presets = await import("../src/genre-presets.js");
});

after(() => {
  fs.rmSync(STORE, { recursive: true, force: true });
  delete process.env.PARTYQUEUE_SETTINGS_FILE;
  settings?.bustSettingsCache();
});

beforeEach(() => {
  if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
  settings.bustSettingsCache();
  autofill.resetRotationCounters();
});

test("does nothing when both switches are off", async () => {
  autofill.savePickerSelection(undefined, presets.presetGenres("party"), "80s");
  const out = await autofill.rotateSelectionIfDue({ poolSize: bigPool });
  assert.equal(out, null);
  assert.equal(autofill.getAutoFillState().mood, "80s");
});

test("decade rotation never repeats the current decade and persists", async () => {
  autofill.savePickerSelection(undefined, undefined, "80s");
  settings.setRotationSettings({
    randomDecadeEnabled: true,
    randomDecadeEverySets: 1,
    randomDecadePool: ["80s", "90s"],
  });
  const out = await autofill.rotateSelectionIfDue({ poolSize: bigPool });
  assert.equal(out.mood, "90s", "only non-current pool entry must win");
  assert.equal(autofill.getAutoFillState().mood, "90s");
  // Persisted through savePickerSelection -> settings file.
  settings.bustSettingsCache();
  assert.equal(settings.loadSettings().mood, "90s");
  // Next set flips back — with a two-entry pool it must alternate forever.
  for (const expected of ["80s", "90s", "80s"]) {
    const next = await autofill.rotateSelectionIfDue({ poolSize: bigPool });
    assert.equal(next.mood, expected);
  }
});

test("mood preset rotation applies the preset's genre buckets", async () => {
  autofill.savePickerSelection(undefined, presets.presetGenres("party"), null);
  settings.setRotationSettings({
    randomMoodEnabled: true,
    randomMoodEverySets: 1,
    randomMoodPool: ["party", "chill"],
  });
  const out = await autofill.rotateSelectionIfDue({ poolSize: bigPool });
  assert.deepEqual(
    [...out.genres].sort(),
    [...presets.presetGenres("chill")].sort()
  );
  assert.equal(out.mood, null, "decade untouched when only mood rotates");
});

test("cadence: every N sets means N-1 quiet sets between changes", async () => {
  autofill.savePickerSelection(undefined, undefined, "80s");
  settings.setRotationSettings({
    randomDecadeEnabled: true,
    randomDecadeEverySets: 3,
    randomDecadePool: ["80s", "90s"],
  });
  assert.equal(await autofill.rotateSelectionIfDue({ poolSize: bigPool }), null);
  assert.equal(await autofill.rotateSelectionIfDue({ poolSize: bigPool }), null);
  const out = await autofill.rotateSelectionIfDue({ poolSize: bigPool });
  assert.equal(out.mood, "90s", "third set is due");
  // Counter reset after a rotation: two more quiet sets follow.
  assert.equal(await autofill.rotateSelectionIfDue({ poolSize: bigPool }), null);
  assert.equal(await autofill.rotateSelectionIfDue({ poolSize: bigPool }), null);
  assert.equal(
    (await autofill.rotateSelectionIfDue({ poolSize: bigPool })).mood,
    "80s"
  );
});

test("pools with fewer than two valid entries never rotate", async () => {
  autofill.savePickerSelection(undefined, undefined, "80s");
  settings.setRotationSettings({
    randomDecadeEnabled: true,
    randomDecadeEverySets: 1,
    // "1880s" is unknown and dropped at validation -> effective pool of one.
    randomDecadePool: ["90s", "1880s"],
  });
  assert.equal(await autofill.rotateSelectionIfDue({ poolSize: bigPool }), null);
  assert.equal(await autofill.rotateSelectionIfDue({ poolSize: bigPool }), null);
  assert.equal(autofill.getAutoFillState().mood, "80s");
});

test("Kids Lock suspends rotation entirely", async () => {
  autofill.savePickerSelection(undefined, undefined, "80s");
  settings.setRotationSettings({
    randomDecadeEnabled: true,
    randomDecadeEverySets: 1,
    randomDecadePool: ["80s", "90s"],
  });
  settings.setContentSettings({ kidsLock: true });
  assert.equal(await autofill.rotateSelectionIfDue({ poolSize: bigPool }), null);
  assert.equal(autofill.getAutoFillState().mood, "80s");
  settings.setContentSettings({ kidsLock: false });
  assert.equal(
    (await autofill.rotateSelectionIfDue({ poolSize: bigPool })).mood,
    "90s"
  );
});

test("starved combos probe the pool and re-roll once", async () => {
  autofill.savePickerSelection(undefined, undefined, "80s");
  settings.setRotationSettings({
    randomDecadeEnabled: true,
    randomDecadeEverySets: 1,
    randomDecadePool: ["80s", "90s"],
  });
  const probes = [];
  const thinPool = async (args) => {
    probes.push(args);
    return { tracks: 0, playlists: 0 };
  };
  const out = await autofill.rotateSelectionIfDue({ poolSize: thinPool });
  // Still applies (era top-up covers shortfalls) but the probe saw the pick.
  assert.equal(out.mood, "90s");
  assert.equal(probes.length, 1, "one probe per rotation");
  assert.deepEqual(probes[0].years, [1990, 1999]);
});
