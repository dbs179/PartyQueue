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
  guests.addGuestNote("Alex", "Alex likes dance classics.");
  guests.addGuestNote("Jordan", "Especially likes Alex.");
  const result = guests.renameGuestProfile("Alex", "Casey");
  assert.equal(result.ok, true);
  assert.equal(result.guest.name, "Casey");
  assert.equal(guests.getGuestProfile("Alex"), null);
  assert.ok(
    guests.getGuestNotesList("Casey").some((n) => n.startsWith("Casey likes"))
  );
  assert.ok(
    guests
      .getGuestNotesList("Jordan")
      .some((n) => /Casey/.test(n) && !/\bAlex\b/.test(n))
  );
});

test("renameGuestProfile refuses colliding names", () => {
  guests.addGuestNote("Alex", "One");
  guests.addGuestNote("Casey", "Two");
  const result = guests.renameGuestProfile("Alex", "Casey");
  assert.equal(result.ok, false);
  assert.match(result.error, /already exists/i);
});
