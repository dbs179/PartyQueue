import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHolidayPlaylistChecks } from "../src/holiday-playlist-selection.js";

const playlists = [
  { id: "p1", name: "Party Hits" },
  { id: "p2", name: "Road Trip" },
  { id: "h1", name: "Holidays - Halloween 2024" },
  { id: "h2", name: "Holidays - Halloween Classics" },
  { id: "h3", name: "Holidays - Halloween 2025" },
  { id: "c1", name: "Holidays - Christmas" },
  { id: "n1", name: "Holidays - New Years" },
  { id: "j1", name: "Holidays - 4th of July" },
  { id: "x1", name: "Nightmare Before Christmas" },
];

const partyIds = ["p1", "p2"];

test("Halloween checks holiday-named playlists and remembers only the new ones", () => {
  const on = applyHolidayPlaylistChecks(playlists, partyIds, {
    fromHolidayId: null,
    toHolidayId: "halloween",
    autoCheckedIds: [],
  });
  assert.deepEqual(on.selectedIds, ["p1", "p2", "h1", "h2", "h3"]);
  assert.deepEqual(on.autoCheckedIds, ["h1", "h2", "h3"]);
});

test("leaving Halloween unchecks only the playlists that holiday added", () => {
  const on = applyHolidayPlaylistChecks(playlists, partyIds, {
    fromHolidayId: null,
    toHolidayId: "halloween",
  });
  const off = applyHolidayPlaylistChecks(playlists, on.selectedIds, {
    fromHolidayId: "halloween",
    toHolidayId: null,
    autoCheckedIds: on.autoCheckedIds,
  });
  assert.deepEqual(off.selectedIds, partyIds);
  assert.deepEqual(off.autoCheckedIds, []);
});

test("a Halloween playlist that was already checked stays checked", () => {
  const on = applyHolidayPlaylistChecks(playlists, ["p1", "h1"], {
    fromHolidayId: null,
    toHolidayId: "halloween",
  });
  assert.deepEqual(on.selectedIds, ["p1", "h1", "h2", "h3"]);
  assert.deepEqual(on.autoCheckedIds, ["h2", "h3"]);
  const off = applyHolidayPlaylistChecks(playlists, on.selectedIds, {
    fromHolidayId: "halloween",
    toHolidayId: null,
    autoCheckedIds: on.autoCheckedIds,
  });
  assert.deepEqual(off.selectedIds, ["p1", "h1"]);
});

test("switching holidays swaps only that holiday's added playlists", () => {
  const halloween = applyHolidayPlaylistChecks(playlists, partyIds, {
    toHolidayId: "halloween",
  });
  const christmas = applyHolidayPlaylistChecks(playlists, halloween.selectedIds, {
    fromHolidayId: "halloween",
    toHolidayId: "christmas",
    autoCheckedIds: halloween.autoCheckedIds,
  });
  assert.deepEqual(christmas.selectedIds, ["p1", "p2", "c1"]);
  assert.deepEqual(christmas.autoCheckedIds, ["c1"]);
  const back = applyHolidayPlaylistChecks(playlists, christmas.selectedIds, {
    fromHolidayId: "christmas",
    toHolidayId: null,
    autoCheckedIds: christmas.autoCheckedIds,
  });
  assert.deepEqual(back.selectedIds, partyIds);
});

test("each holiday chip matches its playlist names", () => {
  const july = applyHolidayPlaylistChecks(playlists, partyIds, {
    toHolidayId: "july4",
  });
  assert.deepEqual(july.autoCheckedIds, ["j1"]);
  const nye = applyHolidayPlaylistChecks(playlists, partyIds, {
    toHolidayId: "newyears",
  });
  assert.deepEqual(nye.autoCheckedIds, ["n1"]);
  const xmas = applyHolidayPlaylistChecks(playlists, partyIds, {
    toHolidayId: "christmas",
  });
  assert.deepEqual(xmas.autoCheckedIds, ["c1"]);
  assert.equal(xmas.selectedIds.includes("x1"), false);
});

test("a manual check outside the holiday survives turning the holiday off", () => {
  const on = applyHolidayPlaylistChecks(playlists, partyIds, {
    toHolidayId: "halloween",
  });
  const withExtra = [...on.selectedIds, "n1"];
  const off = applyHolidayPlaylistChecks(playlists, withExtra, {
    fromHolidayId: "halloween",
    toHolidayId: null,
    autoCheckedIds: on.autoCheckedIds,
  });
  assert.deepEqual(off.selectedIds, ["p1", "p2", "n1"]);
});
