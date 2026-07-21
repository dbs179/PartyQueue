import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_FILE = path.join(
  os.tmpdir(),
  `pq-guests-fresh-${process.pid}-${Date.now()}.json`
);
process.env.PARTYQUEUE_GUESTS_FILE = TMP_FILE;

const guests = await import("../src/guest-profiles.js");

after(() => {
  fs.rmSync(TMP_FILE, { force: true });
});

test("fresh installs seed one fictional sample guest without a birthday", () => {
  assert.equal(fs.existsSync(TMP_FILE), false);

  const profiles = guests.listGuestProfiles();
  assert.deepEqual(
    profiles.map(({ name, notes, birthday }) => ({ name, notes, birthday })),
    [
      {
        name: "Sample Guest",
        notes: [
          "Enjoys upbeat sing-alongs.",
          "Likes a friendly shout-out when their request plays.",
        ],
        birthday: null,
      },
    ]
  );
  assert.equal(fs.existsSync(TMP_FILE), true);
});
