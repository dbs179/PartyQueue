import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatGuestBirthday,
  guestNoteCount,
  guestHubStat,
  guestHubDesc,
  guestOwnsQueueTrack,
} from "../public/js/guest.js";
import {
  guestBirthdayFormValues,
  guestNotesList,
} from "../public/js/guest-hub-ui.js";

test("guestOwnsQueueTrack matches canonical User case-insensitively", () => {
  assert.equal(
    guestOwnsQueueTrack(
      { requestedByUser: "Dave", requestedBy: "DJ Dave" },
      "dave"
    ),
    true
  );
  assert.equal(
    guestOwnsQueueTrack({ requestedBy: "Legacy Guest" }, "legacy guest"),
    true
  );
  assert.equal(
    guestOwnsQueueTrack(
      { requestedByUser: "Maria", requestedBy: "Maria" },
      "Owen"
    ),
    false
  );
  assert.equal(guestOwnsQueueTrack({ searched: true }, "Dave"), false);
  assert.equal(
    guestOwnsQueueTrack({ requestedByUser: "Dave" }, ""),
    false
  );
});

test("formatGuestBirthday formats month day and role", () => {
  assert.equal(
    formatGuestBirthday({ birthday: "08-15", birthdayRole: "star" }),
    "Aug 15 · birthday star"
  );
  assert.equal(formatGuestBirthday({ birthday: "01-01" }), "Jan 1 · birthday star");
  assert.equal(formatGuestBirthday({}), "");
  assert.equal(formatGuestBirthday({ birthday: "bad" }), "");
});

test("guestNoteCount accepts array or single note", () => {
  assert.equal(guestNoteCount({ notes: ["a", "b"] }), 2);
  assert.equal(guestNoteCount({ notes: "solo" }), 1);
  assert.equal(guestNoteCount({}), 0);
});

test("guestHubStat combines notes and birthday", () => {
  assert.equal(
    guestHubStat({ notes: ["hi"], birthday: "03-04", birthdayRole: "host" }),
    "1 note · Mar 4 · birthday host"
  );
  assert.equal(guestHubStat({ notes: [] }), "0 notes · No birthday");
});

test("guestHubDesc truncates long first note", () => {
  assert.equal(guestHubDesc({}), "Tap to add notes or a birthday");
  assert.equal(guestHubDesc({ notes: ["  Short note  "] }), "Short note");
  const long = "x".repeat(80);
  const desc = guestHubDesc({ notes: [long] });
  assert.equal(desc.length, 72);
  assert.ok(desc.endsWith("…"));
});

test("guestBirthdayFormValues parses MM-DD and defaults role", () => {
  assert.deepEqual(
    guestBirthdayFormValues({ birthday: "08-15", birthdayRole: "host" }),
    { month: "8", day: "15", role: "host" }
  );
  assert.deepEqual(guestBirthdayFormValues({}), {
    month: "",
    day: "",
    role: "star",
  });
});

test("guestNotesList normalizes array or string notes", () => {
  assert.deepEqual(guestNotesList({ notes: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(guestNotesList({ notes: "solo" }), ["solo"]);
  assert.deepEqual(guestNotesList({}), []);
});
