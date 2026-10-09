import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeHoliday,
  easterSunday,
  thanksgivingDay,
  filterPlaylistsToHoliday,
  holidayPack,
  holidaysMatchingTrack,
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
  assert.equal(activeHoliday(at(2026, 12, 31))?.id, "newyears");
  assert.equal(activeHoliday(at(2027, 1, 1))?.label, "New Years");
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
  assert.equal(activeHoliday(at(2026, 7, 4))?.label, "Independence Day");
  assert.equal(activeHoliday(at(2026, 7, 5)), null);
});

test("Last.fm charts are only used where the tag is a real holiday playlist", () => {
  assert.deepEqual(holidayPack("halloween").lastfmTags, ["halloween"]);
  assert.deepEqual(holidayPack("christmas").lastfmTags, ["christmas"]);
  assert.equal(holidayPack("july4").lastfmTags, undefined);
  assert.equal(holidayPack("newyears").lastfmTags, undefined);
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

test("Auld Lang Syne is New Years, in season only on New Year", () => {
  const track = { name: "Auld Lang Syne", album: "Party" };
  assert.deepEqual(holidaysMatchingTrack(track), ["newyears"]);
  assert.equal(isOutOfSeasonHolidayTrack(track, at(2026, 10, 2)), true);
  assert.equal(isOutOfSeasonHolidayTrack(track, at(2026, 12, 31)), false);
  assert.equal(isOutOfSeasonHolidayTrack(track, at(2027, 1, 2)), true);
});

test("a Halloween playlist is in season only in October", () => {
  const pl = { name: "Holidays - Halloween 2025" };
  assert.equal(isOutOfSeasonHolidayPlaylist(pl, at(2026, 9, 20)), true);
  assert.equal(isOutOfSeasonHolidayPlaylist(pl, at(2026, 10, 2)), false);
});

test("holiday pool keeps labeled tracks and Last.fm chart matches", () => {
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
          { uri: "spotify:track:plain", name: "Since U Been Gone", artist: "Kelly" },
          { uri: "spotify:track:tree", name: "Underneath the Tree", artist: "Kelly" },
        ],
      },
    ],
    halloween
  );
  const ids = filtered.flatMap((p) => p.tracks.map((t) => t.uri));
  assert.deepEqual(ids, ["spotify:track:mash", "spotify:track:ghost"]);

  const withChart = filterPlaylistsToHoliday(
    [
      {
        id: "mixed",
        name: "Party",
        tracks: [
          { uri: "spotify:track:mash", name: "Monster Mash", artist: "Bobby" },
          {
            uri: "spotify:track:goo",
            name: "Goo Goo Muck",
            artist: "The Cramps",
          },
          { uri: "spotify:track:pop", name: "Since U Been Gone", artist: "Kelly" },
          {
            uri: "spotify:track:other",
            name: "Goo Goo Muck",
            artist: "Somebody Else",
          },
        ],
      },
    ],
    halloween,
    [{ artist: "The Cramps", name: "Goo Goo Muck" }]
  );
  assert.deepEqual(
    withChart.flatMap((p) => p.tracks.map((t) => t.uri)),
    ["spotify:track:mash", "spotify:track:goo"]
  );
});

test("holiday pool skips sound-effect albums and clips under 90 seconds", () => {
  const halloween = activeHoliday(at(2026, 10, 2));
  const filtered = filterPlaylistsToHoliday(
    [
      {
        id: "halloween",
        name: "Holidays - Halloween",
        tracks: [
          {
            uri: "spotify:track:mash",
            name: "Monster Mash",
            artist: "Bobby Pickett",
            album: "The Original Monster Mash",
            durationMs: 192000,
          },
          {
            uri: "spotify:track:creak",
            name: "Door Creak",
            artist: "Horror FX",
            album: "Halloween Sound Effects",
            durationMs: 12000,
          },
          {
            uri: "spotify:track:thunder",
            name: "Halloween Thunder",
            artist: "Storm Library",
            album: "Night Noises",
            durationMs: 45000,
          },
          {
            uri: "spotify:track:yard",
            name: "Graveyard Wind",
            artist: "Night Library",
            album: "Halloween Ambience",
            durationMs: 600000,
          },
          {
            uri: "spotify:track:goo",
            name: "Goo Goo Muck",
            artist: "The Cramps",
            album: "Songs the Lord Taught Us",
            durationMs: 180000,
          },
        ],
      },
    ],
    halloween,
    [{ artist: "The Cramps", name: "Goo Goo Muck" }]
  );
  assert.deepEqual(
    filtered.flatMap((p) => p.tracks.map((t) => t.uri)),
    ["spotify:track:mash", "spotify:track:goo"]
  );
});
