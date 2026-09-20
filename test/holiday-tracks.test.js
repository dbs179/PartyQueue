import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isHolidaySeason,
  isHolidayTrack,
  isHolidayPlaylistName,
  isOutOfSeasonHolidayTrack,
  isOutOfSeasonHolidayPlaylist,
} from "../src/holiday-tracks.js";

const AUG = new Date("2026-08-28T12:00:00");
const SEP = new Date("2026-09-20T12:00:00");
const DEC = new Date("2026-12-20T12:00:00");
const NOV_EARLY = new Date("2026-11-10T12:00:00");
const NOV_LATE = new Date("2026-11-15T12:00:00");
const JAN_2 = new Date("2027-01-02T12:00:00");
const JAN_3 = new Date("2027-01-03T12:00:00");

test("holiday window is mid-November through January 2", () => {
  assert.equal(isHolidaySeason(AUG), false);
  assert.equal(isHolidaySeason(SEP), false);
  assert.equal(isHolidaySeason(NOV_EARLY), false);
  assert.equal(isHolidaySeason(NOV_LATE), true);
  assert.equal(isHolidaySeason(DEC), true);
  assert.equal(isHolidaySeason(JAN_2), true);
  assert.equal(isHolidaySeason(JAN_3), false);
});

test("detects Christmas titles including ones without the word Christmas", () => {
  assert.equal(isHolidayTrack({ name: "Underneath the Tree" }), true);
  assert.equal(
    isHolidayTrack({ name: "All I Want for Christmas Is You" }),
    true
  );
  assert.equal(isHolidayTrack({ name: "Last Christmas" }), true);
  assert.equal(isHolidayTrack({ name: "Let It Snow" }), true);
  assert.equal(isHolidayTrack({ name: "Winter Wonderland" }), true);
  assert.equal(isHolidayTrack({ name: "Santa Baby" }), true);
  assert.equal(isHolidayTrack({ name: "Feliz Navidad" }), true);
  assert.equal(
    isHolidayTrack({ name: "Since U Been Gone", album: "Wrapped in Red" }),
    true
  );
  assert.equal(
    isHolidayTrack({ name: "My Only Wish (This Year)", artist: "Britney Spears" }),
    true
  );
  assert.equal(
    isHolidayTrack({ name: "Not Tonight Santa", artist: "Girls Aloud" }),
    true
  );
  assert.equal(isHolidayTrack({ name: "Wonderful Christmastime" }), true);
  assert.equal(isHolidayTrack({ name: "Jingle Bells" }), true);
  assert.equal(isHolidayTrack({ name: "Frosty the Snowman" }), true);
  assert.equal(isHolidayTrack({ name: "Rudolph the Red-Nosed Reindeer" }), true);
  assert.equal(isHolidayTrack({ name: "Silver Bells" }), true);
  assert.equal(
    isHolidayTrack({ name: "Believe", album: "The Polar Express" }),
    true
  );
});

test("does not flag ordinary songs that only look a little seasonal", () => {
  assert.equal(isHolidayTrack({ name: "Holiday", artist: "Madonna" }), false);
  assert.equal(isHolidayTrack({ name: "Holiday", artist: "Green Day" }), false);
  assert.equal(isHolidayTrack({ name: "Santa Monica" }), false);
  assert.equal(isHolidayTrack({ name: "Family Tree" }), false);
  assert.equal(isHolidayTrack({ name: "Snow (Hey Oh)" }), false);
  assert.equal(isHolidayTrack({ name: "Since U Been Gone" }), false);
  assert.equal(
    isHolidayTrack({ name: "Joy to the World", artist: "Three Dog Night" }),
    false
  );
});

test("out-of-season filter blocks Christmas in August and allows it in December", () => {
  const tree = { name: "Underneath the Tree", artist: "Kelly Clarkson" };
  assert.equal(isOutOfSeasonHolidayTrack(tree, AUG), true);
  assert.equal(isOutOfSeasonHolidayTrack(tree, DEC), false);
  assert.equal(
    isOutOfSeasonHolidayTrack({ name: "Since U Been Gone" }, AUG),
    false
  );
  assert.equal(
    isOutOfSeasonHolidayTrack(
      { name: "My Only Wish (This Year)", artist: "Britney Spears" },
      SEP
    ),
    true
  );
});

test("Christmas-named playlists are skipped outside the holiday window", () => {
  assert.equal(isHolidayPlaylistName("Holidays - Christmas Music"), true);
  assert.equal(isHolidayPlaylistName("Holidays - Halloween 2025"), false);
  assert.equal(isHolidayPlaylistName("Top Hits - 2025"), false);
  const xmas = { name: "Holidays - Christmas Metal" };
  assert.equal(isOutOfSeasonHolidayPlaylist(xmas, SEP), true);
  assert.equal(isOutOfSeasonHolidayPlaylist(xmas, DEC), false);
});
