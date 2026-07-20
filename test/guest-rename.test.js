import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_FILE = path.join(
  os.tmpdir(),
  `pq-guests-${process.pid}-${Date.now()}.json`
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
  // Force reload by clearing through delete of any leftover — module cache
  // holds state; wipe via API.
  for (const g of guests.listGuestProfiles()) {
    guests.deleteGuestProfile(g.name);
  }
});

test("renameGuestProfile moves key and rewrites notes", () => {
  guests.addGuestNote("DK", "DK is a dipshit.");
  guests.addGuestNote("Sarah", "Especially likes DK.");
  const result = guests.renameGuestProfile("DK", "Darin");
  assert.equal(result.ok, true);
  assert.equal(result.guest.name, "Darin");
  assert.equal(guests.getGuestProfile("DK"), null);
  assert.ok(
    guests.getGuestNotesList("Darin").some((n) => n.startsWith("Darin is"))
  );
  assert.ok(
    guests
      .getGuestNotesList("Sarah")
      .some((n) => /Darin/.test(n) && !/\bDK\b/.test(n))
  );
});

test("renameGuestProfile refuses colliding names", () => {
  guests.addGuestNote("DK", "One");
  guests.addGuestNote("Darin", "Two");
  const result = guests.renameGuestProfile("DK", "Darin");
  assert.equal(result.ok, false);
  assert.match(result.error, /already exists/i);
});
