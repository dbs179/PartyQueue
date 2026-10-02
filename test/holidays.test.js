import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeHoliday,
  easterSunday,
  thanksgivingDay,
  filterPlaylistsToHoliday,
  isOutOfSeasonHolidayTrack,
  isOutOfSeasonHolidayPlaylist,
} from "../src/holidays.js";

const at = (y, m, d) => new Date(y, m - 1, d, 12);

test("2 Oct 2026 is Halloween and 1 Nov is no holiday", () => {
  assert.equal(activeHoliday(at(2026, 10, 2))?.id, "halloween");
  assert.equal(activeHoliday(at(2026, 10, 1))?.label, "Halloween");
  assert.equal(activeHoliday(at(2026, 10, 31))?.id, "halloween");
  assert.equal(activeHoliday(at(2026, 11, 1)), null);
  assert.equal(activeHoliday(at(2026, 9, 30)), null);
});

test("Easter 2026 is 5 Apr and the window is the week before", () => {
  assert.deepEqual(easterSunday(2026), { year: 2026, month: 4, day: 5 });
  assert.equal(activeHoliday(at(2026, 3, 28)), null);
  assert.equal(activeHoliday(at(2026, 3, 29))?.id, "easter");
  assert.equal(activeHoliday(at(2026, 4, 5))?.id, "easter");
  assert.equal(activeHoliday(at(2026, 4, 6)), null);
});

test("Thanksgiving 2026 beats Christmas, then Christmas resumes", () => {
  assert.equal(thanksgivingDay(2026), 26);
  assert.equal(activeHoliday(at(2026, 11, 15))?.id, "christmas");
  assert.equal(activeHoliday(at(2026, 11, 22))?.id, "christmas");
  assert.equal(activeHoliday(at(2026, 11, 23))?.id, "thanksgiving");
  assert.equal(activeHoliday(at(2026, 11, 26))?.id, "thanksgiving");
  assert.equal(activeHoliday(at(2026, 11, 27))?.id, "christmas");
  assert.equal(activeHoliday(at(2027, 1, 2))?.id, "christmas");
  assert.equal(activeHoliday(at(2027, 1, 3)), null);
});

test("fixed windows pick Valentine's, St. Patrick's, and the Fourth", () => {
  assert.equal(activeHoliday(at(2026, 2, 1))?.id, "valentines");
  assert.equal(activeHoliday(at(2026, 2, 14))?.id, "valentines");
  assert.equal(activeHoliday(at(2026, 2, 15)), null);
  assert.equal(activeHoliday(at(2026, 3, 17))?.id, "stpatricks");
  assert.equal(activeHoliday(at(2026, 3, 18)), null);
  assert.equal(activeHoliday(at(2026, 6, 28))?.id, "july4");
  assert.equal(activeHoliday(at(2026, 7, 4))?.id, "july4");
  assert.equal(activeHoliday(at(2026, 7, 5)), null);
});

test("Halloween tracks are skipped in July and allowed in October", () => {
  const mash = { name: "Monster Mash", artist: "Bobby Pickett" };
  const july = at(2026, 7, 10);
  const oct = at(2026, 10, 2);
  assert.equal(isOutOfSeasonHolidayTrack(mash, july), true);
  assert.equal(isOutOfSeasonHolidayTrack(mash, oct), false);
  assert.equal(
    isOutOfSeasonHolidayTrack({ name: "Since U Been Gone" }, july),
    false
  );
  assert.equal(
    isOutOfSeasonHolidayTrack(
      { name: "This Is Halloween", album: "The Nightmare Before Christmas" },
      oct
    ),
    false
  );
  assert.equal(
    isOutOfSeasonHolidayTrack(
      { name: "This Is Halloween", album: "The Nightmare Before Christmas" },
      july
    ),
    true
  );
});

test("a Halloween playlist is in season only in October", () => {
  const pl = { name: "Holidays - Halloween 2025" };
  assert.equal(isOutOfSeasonHolidayPlaylist(pl, at(2026, 9, 20)), true);
  assert.equal(isOutOfSeasonHolidayPlaylist(pl, at(2026, 10, 2)), false);
});

test("holiday pool keeps matching tracks and a named playlist", () => {
  const halloween = activeHoliday(at(2026, 10, 2));
  const filtered = filterPlaylistsToHoliday(
    [
      {
        id: "mixed",
        name: "Party",
        tracks: [
          { uri: "spotify:track:mash", name: "Monster Mash", artist: "Bobby" },
          { uri: "spotify:track:pop", name: "Since U Been Gone", artist: "Kelly" },
          { uri: "spotify:track:xmas", name: "Last Christmas", artist: "Wham!" },
        ],
      },
      {
        id: "named",
        name: "Halloween 2025",
        tracks: [
          { uri: "spotify:track:ghost", name: "Ghostbusters", artist: "Ray" },
          { uri: "spotify:track:tree", name: "Underneath the Tree", artist: "Kelly" },
        ],
      },
    ],
    halloween
  );
  const ids = filtered.flatMap((p) => p.tracks.map((t) => t.uri));
  assert.deepEqual(ids, ["spotify:track:mash", "spotify:track:ghost"]);
});
