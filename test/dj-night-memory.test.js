import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_MEM = path.join(
  os.tmpdir(),
  `pq-dj-memory-${process.pid}-${Date.now()}.json`
);
const TMP_GUESTS = path.join(
  os.tmpdir(),
  `pq-guests-${process.pid}-${Date.now()}.json`
);
const TMP_SETTINGS = path.join(
  os.tmpdir(),
  `pq-dj-settings-${process.pid}-${Date.now()}.json`
);

process.env.PARTYQUEUE_DJ_MEMORY_FILE = TMP_MEM;
process.env.PARTYQUEUE_GUESTS_FILE = TMP_GUESTS;
process.env.PARTYQUEUE_SETTINGS_FILE = TMP_SETTINGS;

const mem = await import("../src/dj-night-memory.js");
const guests = await import("../src/guest-profiles.js");
const { shouldShoutOnSearch, resetSearchAddCountForTests } = await import(
  "../src/dj-shout.js"
);
const { writeRecapScript, tonightBirthdayGuests, END_OF_NIGHT_SIGNOFFS } =
  await import("../src/party-recap.js");
const { getDjVoiceSettings, setDjVoiceSettings } = await import(
  "../src/settings.js"
);

beforeEach(() => {
  mem.clearDjNightMemory();
  resetSearchAddCountForTests();
  for (const name of ["Mark", "Alex", "Jen", "Sam", "Alice"]) {
    guests.deleteGuestProfile(name);
  }
});

after(() => {
  try {
    fs.rmSync(TMP_MEM, { force: true });
    fs.rmSync(TMP_GUESTS, { force: true });
    fs.rmSync(TMP_SETTINGS, { force: true });
  } catch {
    /* ok */
  }
  delete process.env.PARTYQUEUE_SETTINGS_FILE;
});

test("isFirstShoutTonight is true until rememberShout, then false", () => {
  assert.equal(mem.isFirstShoutTonight("Mark"), true);
  mem.rememberShout({
    name: "Mark",
    script: "Shout-out to Mark!",
    notes: ["Mark likes crayons"],
  });
  assert.equal(mem.isFirstShoutTonight("Mark"), false);
  assert.equal(mem.isFirstShoutTonight("Alex"), true);
});

test("anonymous / empty names are never first-shout tonight", () => {
  assert.equal(mem.isFirstShoutTonight(""), false);
  assert.equal(mem.isFirstShoutTonight(null), false);
});

test("shouldBirthdayShout once per night for today's birthday guest", () => {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  guests.setGuestBirthday("Mark", `${mm}-${dd}`, "boy");

  assert.equal(mem.shouldBirthdayShout("Mark", now.getTime()), true);
  mem.rememberShout(
    {
      name: "Mark",
      script: "Happy birthday birthday boy Mark!",
      birthday: true,
    },
    now.getTime()
  );
  assert.equal(mem.shouldBirthdayShout("Mark", now.getTime()), false);
});

test("pickFreshNotes prefers unused notes, then oldest-used", () => {
  const candidates = ["Note A crayons", "Note B Gypsy", "Note C cook"];
  const first = mem.pickFreshNotes("Mark", candidates, 2);
  assert.equal(first.length, 2);
  mem.rememberShout({ name: "Mark", notes: first, script: "first" });

  const second = mem.pickFreshNotes("Mark", candidates, 2);
  assert.equal(second.length, 2);
  // The one unused note must be included.
  const unused = candidates.find((c) => !first.includes(c));
  assert.ok(second.includes(unused));

  mem.rememberShout({ name: "Mark", notes: second, script: "second" });
  // All used — still returns notes (wrap to oldest).
  const third = mem.pickFreshNotes("Mark", candidates, 2);
  assert.equal(third.length, 2);
});

test("getRecentScripts returns remembered lines", () => {
  mem.rememberShout({ name: "Mark", script: "Line one about crayons" });
  mem.rememberShout({ name: "Mark", script: "Line two about cooking" });
  const recent = mem.getRecentScripts("Mark", 3);
  assert.deepEqual(recent, [
    "Line one about crayons",
    "Line two about cooking",
  ]);
});

test("global DJ phrases stay fresh, then reuse least-recently used", () => {
  const bank = [
    { id: "intro-a", text: "First option" },
    { id: "intro-b", text: "Second option" },
  ];
  const now = Date.now();
  assert.equal(
    mem.reserveDjPhrase("intro", bank, { salt: 0, now }).id,
    "intro-a"
  );
  assert.equal(
    mem.reserveDjPhrase("intro", bank, { salt: 0, now: now + 1 }).id,
    "intro-b"
  );
  assert.equal(
    mem.reserveDjPhrase("intro", bank, { salt: 1, now: now + 2 }).id,
    "intro-a"
  );
});

test("global phrase reservations survive a memory reload", () => {
  const bank = [
    { id: "aside-a", text: "First aside" },
    { id: "aside-b", text: "Second aside" },
  ];
  const now = Date.now();
  assert.equal(
    mem.reserveDjPhrase("aside", bank, { salt: 0, now }).id,
    "aside-a"
  );
  mem.resetDjNightMemoryCacheForTests();
  assert.equal(
    mem.reserveDjPhrase("aside", bank, { salt: 0, now: now + 1 }).id,
    "aside-b"
  );
});

test("global announce memory is bounded and pruned after twelve hours", () => {
  const now = Date.now();
  for (let i = 0; i < 25; i += 1) {
    mem.rememberDjAnnounceScript(`Script ${i}`, now + i);
  }
  assert.equal(mem.getRecentDjAnnounceScripts(50, now + 30).length, 20);
  assert.deepEqual(mem.getRecentDjAnnounceScripts(2, now + 30), [
    "Script 23",
    "Script 24",
  ]);

  const expired = now + (mem.NIGHT_WINDOW_HOURS * 60 * 60_000) + 100;
  assert.deepEqual(mem.getRecentDjAnnounceScripts(5, expired), []);
});

test("old DJ memory files load without global announce history", () => {
  mem.clearDjNightMemory();
  fs.writeFileSync(
    TMP_MEM,
    JSON.stringify({
      guests: {
        Mark: {
          firstShoutAt: Date.now(),
          recentScripts: [{ text: "Legacy shout", ts: Date.now() }],
        },
      },
    })
  );
  mem.resetDjNightMemoryCacheForTests();
  assert.deepEqual(mem.getRecentDjAnnounceScripts(5), []);
  assert.deepEqual(mem.getRecentScripts("Mark", 1), ["Legacy shout"]);
});

test("descriptor reservations cycle the whole bank before repeating, then LRU", () => {
  const bank = Array.from({ length: 12 }, (_, i) => ({
    id: `desc-cycle-${i}`,
    text: `descriptor ${i}`,
  }));
  const now = Date.now();
  const seen = [];
  for (let i = 0; i < bank.length; i += 1) {
    seen.push(
      mem.reserveDjPhrase("descriptor", bank, { salt: i * 7, now: now + i }).id
    );
  }
  assert.equal(new Set(seen).size, bank.length, "no repeats until exhaustion");
  // Bank exhausted — the least-recently-used line recycles first.
  assert.equal(
    mem.reserveDjPhrase("descriptor", bank, { salt: 3, now: now + 100 }).id,
    seen[0]
  );
});

test("night memory holds a full night of intro/outro/descriptor reservations", () => {
  const now = Date.now();
  const mkBank = (prefix) =>
    Array.from({ length: 100 }, (_, i) => ({
      id: `${prefix}-${i}`,
      text: `${prefix} line ${i}`,
    }));
  const intros = mkBank("cap-intro");
  const outros = mkBank("cap-outro");
  const descriptors = mkBank("cap-desc");
  for (let i = 0; i < 100; i += 1) {
    mem.reserveDjPhrase("intro", intros, { salt: i, now: now + i * 3 });
    mem.reserveDjPhrase("outro", outros, { salt: i, now: now + i * 3 + 1 });
    mem.reserveDjPhrase("descriptor", descriptors, {
      salt: i,
      now: now + i * 3 + 2,
    });
  }
  // 300 reservations must fit without evicting the earliest ones (cap 600).
  assert.equal(mem.getRecentDjPhraseIds("intro", 200, now + 1000).length, 100);
  assert.equal(mem.getRecentDjPhraseIds("outro", 200, now + 1000).length, 100);
  assert.equal(
    mem.getRecentDjPhraseIds("descriptor", 200, now + 1000).length,
    100
  );
});

test("clear DJ memory also clears global phrases and scripts", () => {
  mem.reserveDjPhrase("outro", [{ id: "outro-a", text: "Keep it moving" }]);
  mem.rememberDjAnnounceScript("A recent global set script");
  mem.clearDjNightMemory();
  assert.deepEqual(mem.getRecentDjPhraseIds("outro"), []);
  assert.deepEqual(mem.getRecentDjAnnounceScripts(), []);
});

test("shouldShoutOnSearch forces first named request even when percent is 0", () => {
  const prev = getDjVoiceSettings();
  try {
    setDjVoiceSettings({
      djShoutEnabled: true,
      djShoutMode: "percent",
      djShoutPercent: 0,
    });

    assert.equal(
      shouldShoutOnSearch({ requestedBy: "Mark", ready: true }),
      true,
      "first request always shouts"
    );
    // Decision reserves first-shout immediately (no wait for TTS) so a concurrent
    // second add cannot also claim first-shout and stack another announce.
    assert.equal(mem.isFirstShoutTonight("Mark"), false);
    assert.equal(
      shouldShoutOnSearch({ requestedBy: "Mark", ready: true }),
      false,
      "second request follows percent=0"
    );
    assert.equal(
      shouldShoutOnSearch({ requestedBy: "Alex", ready: true }),
      true,
      "different guest still gets first-shout"
    );
  } finally {
    setDjVoiceSettings({
      djShoutEnabled: prev.djShoutEnabled,
      djShoutMode: prev.djShoutMode,
      djShoutPercent: prev.djShoutPercent,
    });
  }
});

test("shouldShoutOnSearch force empty-queue reserves first-shout for concurrent adds", () => {
  const prev = getDjVoiceSettings();
  try {
    setDjVoiceSettings({
      djShoutEnabled: true,
      djShoutMode: "percent",
      djShoutPercent: 0,
    });
    assert.equal(
      shouldShoutOnSearch({ force: true, requestedBy: "Sam", ready: true }),
      true
    );
    assert.equal(mem.isFirstShoutTonight("Sam"), false);
    assert.equal(
      shouldShoutOnSearch({ requestedBy: "Sam", ready: true }),
      false,
      "concurrent follow-up must not also force first-shout"
    );
  } finally {
    setDjVoiceSettings({
      djShoutEnabled: prev.djShoutEnabled,
      djShoutMode: prev.djShoutMode,
      djShoutPercent: prev.djShoutPercent,
    });
  }
});

test("shouldShoutOnSearch keys first-shout on User, not queue alias", async () => {
  // Server resolves identity and passes User into shouldShoutOnSearch /
  // announceRequestShout — alias must not create a second first-shout bucket.
  const { resolveGuestIdentity } = await import("../src/display-name.js");
  const prev = getDjVoiceSettings();
  try {
    setDjVoiceSettings({
      djShoutEnabled: true,
      djShoutMode: "percent",
      djShoutPercent: 0,
    });
    const first = resolveGuestIdentity({
      requestedBy: "Party Alex",
      requestedByUser: "Mark",
    });
    assert.equal(first.user, "Mark");
    assert.equal(first.badge, "Party Alex");
    assert.equal(
      shouldShoutOnSearch({ requestedBy: first.user, ready: true }),
      true
    );
    mem.rememberShout({ name: first.user, script: "hey Mark" });
    const second = resolveGuestIdentity({
      requestedBy: "Alias Mark",
      requestedByUser: "Mark",
    });
    assert.equal(
      shouldShoutOnSearch({ requestedBy: second.user, ready: true }),
      false,
      "alias change must not re-trigger first-shout"
    );
    assert.equal(mem.isFirstShoutTonight("Party Alex"), true);
    assert.equal(mem.isFirstShoutTonight("Mark"), false);
  } finally {
    setDjVoiceSettings({
      djShoutEnabled: prev.djShoutEnabled,
      djShoutMode: prev.djShoutMode,
      djShoutPercent: prev.djShoutPercent,
    });
  }
});

test("shouldShoutOnSearch stays off when shout-outs disabled", () => {
  const prev = getDjVoiceSettings();
  try {
    setDjVoiceSettings({ djShoutEnabled: false });
    assert.equal(
      shouldShoutOnSearch({ requestedBy: "Mark", ready: true }),
      false
    );
  } finally {
    setDjVoiceSettings({ djShoutEnabled: prev.djShoutEnabled });
  }
});

test("shouldShoutOnSearch every-N=5: empty force then later hits on 5th counted add", () => {
  // Empty-queue force always shouts and advances the counter; subsequent adds
  // from the same guest follow every-N (not always-shout).
  const prev = getDjVoiceSettings();
  try {
    setDjVoiceSettings({
      djShoutEnabled: true,
      djShoutMode: "every",
      djShoutEveryN: 5,
    });
    assert.equal(
      shouldShoutOnSearch({ force: true, requestedBy: "Alice", ready: true }),
      true,
      "empty queue always shouts"
    );
    // Adds 2–4: counted, no shout. Add 5: shout.
    assert.equal(
      shouldShoutOnSearch({ requestedBy: "Alice", ready: true }),
      false
    );
    assert.equal(
      shouldShoutOnSearch({ requestedBy: "Alice", ready: true }),
      false
    );
    assert.equal(
      shouldShoutOnSearch({ requestedBy: "Alice", ready: true }),
      false
    );
    assert.equal(
      shouldShoutOnSearch({ requestedBy: "Alice", ready: true }),
      true,
      "5th counted search add shouts"
    );
  } finally {
    setDjVoiceSettings({
      djShoutEnabled: prev.djShoutEnabled,
      djShoutMode: prev.djShoutMode,
      djShoutEveryN: prev.djShoutEveryN,
    });
  }
});

test("shouldShoutOnSearch every-N: other guest first-shout does not advance counter", () => {
  const prev = getDjVoiceSettings();
  try {
    setDjVoiceSettings({
      djShoutEnabled: true,
      djShoutMode: "every",
      djShoutEveryN: 5,
    });
    assert.equal(
      shouldShoutOnSearch({ force: true, requestedBy: "Alice", ready: true }),
      true
    );
    assert.equal(
      shouldShoutOnSearch({ requestedBy: "Alex", ready: true }),
      true,
      "new guest first-shout"
    );
    // Still only 1 counted add (Alice force); next Alice add → count 2, no shout.
    assert.equal(
      shouldShoutOnSearch({ requestedBy: "Alice", ready: true }),
      false
    );
  } finally {
    setDjVoiceSettings({
      djShoutEnabled: prev.djShoutEnabled,
      djShoutMode: prev.djShoutMode,
      djShoutEveryN: prev.djShoutEveryN,
    });
  }
});

test("writeRecapScript includes birthday beat for tonight's birthday guests", () => {
  const script = writeRecapScript(
    {
      total: 4,
      topSongs: [{ name: "Goodbye Horses", artist: "Q Lazzarus", count: 2 }],
      topArtists: [],
    },
    [{ name: "Mark", count: 3 }],
    [{ name: "Mark", label: "birthday boy" }]
  );
  assert.match(script, /birthday/i);
  assert.match(script, /Mark/);
  assert.match(script, /birthday boy/i);
});

test("writeRecapScript always signs off with a line from the pack", () => {
  // Tight word budget on purpose: the sign-off rides outside the trim, so it
  // must survive even when the recap body gets cut.
  const prev = getDjVoiceSettings();
  setDjVoiceSettings({ djAnnounceMaxWords: 28 });
  try {
    for (let i = 0; i < 25; i++) {
      const script = writeRecapScript(
        {
          total: 12,
          topSongs: [{ name: "Goodbye Horses", artist: "Q Lazzarus", count: 2 }],
          topArtists: [],
        },
        [{ name: "Mark", count: 3 }]
      );
      assert.ok(
        END_OF_NIGHT_SIGNOFFS.some((line) => script.endsWith(line)),
        `recap must end with a pack sign-off, got: "${script}"`
      );
    }
  } finally {
    setDjVoiceSettings({ djAnnounceMaxWords: prev.djAnnounceMaxWords });
  }
});

test("tonightBirthdayGuests filters to calendar birthdays in the window", () => {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  guests.setGuestBirthday("Mark", `${mm}-${dd}`, "boy");
  guests.setGuestBirthday("Alex", "01-01", "boy");

  const ts = now.getTime();
  const found = tonightBirthdayGuests(
    [
      { requestedBy: "Mark", ts },
      { requestedBy: "Alex", ts },
      { requestedBy: "Jen", ts },
    ],
    ts - 1000,
    now
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "Mark");
  assert.equal(found[0].label, "birthday boy");
});

test("clearDjNightMemory resets first-shout and birthday flags", () => {
  mem.rememberShout({
    name: "Mark",
    script: "hi",
    birthday: true,
    notes: ["x"],
  });
  mem.clearDjNightMemory();
  assert.equal(mem.isFirstShoutTonight("Mark"), true);
});

test("forgetBirthdayShout clears birthday + first-shout but keeps blurbs", () => {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  guests.setGuestBirthday("Mark", `${mm}-${dd}`, "boy");

  mem.rememberShout({
    name: "Mark",
    script: "Happy birthday Mark crayons",
    birthday: true,
    notes: ["Mark likes crayons"],
  });
  assert.equal(mem.isFirstShoutTonight("Mark"), false);
  assert.equal(mem.shouldBirthdayShout("Mark"), false);
  assert.deepEqual(mem.getRecentScripts("Mark", 1), [
    "Happy birthday Mark crayons",
  ]);

  assert.equal(mem.forgetBirthdayShout("Mark"), true);
  assert.equal(mem.isFirstShoutTonight("Mark"), true);
  assert.equal(mem.shouldBirthdayShout("Mark"), true);
  // Anti-repeat history kept.
  assert.deepEqual(mem.getRecentScripts("Mark", 1), [
    "Happy birthday Mark crayons",
  ]);
});
