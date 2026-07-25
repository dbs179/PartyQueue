import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_FILE = path.join(
  os.tmpdir(),
  `pq-guests-ensure-${process.pid}-${Date.now()}.json`
);
process.env.PARTYQUEUE_GUESTS_FILE = TMP_FILE;

const guests = await import("../src/guest-profiles.js");

before(() => {
  fs.writeFileSync(TMP_FILE, "{}");
});

after(() => {
  try {
    fs.rmSync(TMP_FILE, { force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  fs.writeFileSync(TMP_FILE, "{}");
  for (const g of guests.listGuestProfiles()) {
    guests.deleteGuestProfile(g.name);
  }
});

test("ensureGuestProfile creates an empty profile for a new name", () => {
  assert.equal(guests.ensureGuestProfile("Dana"), true);
  const profile = guests.getGuestProfile("Dana");
  assert.equal(profile.name, "Dana");
  assert.deepEqual(profile.notes, []);
  assert.equal(profile.birthday, null);
  assert.ok(guests.listGuestProfiles().some((g) => g.name === "Dana"));
});

test("ensureGuestProfile is idempotent and case-insensitive", () => {
  assert.equal(guests.ensureGuestProfile("Dana"), true);
  assert.equal(guests.ensureGuestProfile("Dana"), false);
  assert.equal(guests.ensureGuestProfile("dana"), false);
  assert.equal(guests.ensureGuestProfile("DANA"), false);
  assert.equal(
    guests.listGuestProfiles().filter((g) => g.name.toLowerCase() === "dana")
      .length,
    1
  );
});

test("ensureGuestProfile never clobbers existing notes or birthday", () => {
  guests.addGuestNote("Riley", "Loves 80s synth pop.");
  guests.setGuestBirthday("Riley", "07-24", "star");
  assert.equal(guests.ensureGuestProfile("riley"), false);
  const profile = guests.getGuestProfile("Riley");
  assert.deepEqual(profile.notes, ["Loves 80s synth pop."]);
  assert.equal(profile.birthday, "07-24");
});

test("ensureGuestProfile rejects blank and non-string names", () => {
  assert.equal(guests.ensureGuestProfile(""), false);
  assert.equal(guests.ensureGuestProfile("   "), false);
  assert.equal(guests.ensureGuestProfile(null), false);
  assert.equal(guests.ensureGuestProfile(undefined), false);
  assert.equal(guests.listGuestProfiles().length, 0);
});
