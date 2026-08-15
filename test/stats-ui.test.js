import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatNameList,
  statRows,
  paintStatsReactionList,
  statsSummaryCardsHtml,
  displayTonightStatsHtml,
  displayWindowStatsHtml,
  paintDisplayTonightStats,
  dedicationsHtml,
  karaokeRowsHtml,
  statsEmptyMessage,
  REACTION_EMOJI,
} from "../public/js/stats-ui.js";

test("formatNameList sanitizes and joins names", () => {
  assert.equal(formatNameList(["Dave", "  "]), "Dave, Guest");
  assert.equal(formatNameList(null), "");
});

test("statRows renders song / artist / requester rows", () => {
  const songHtml = statRows(
    [{ name: "Thunderstruck", artist: "AC/DC", count: 3 }],
    "song"
  );
  assert.match(songHtml, /Thunderstruck/);
  assert.match(songHtml, /AC\/DC/);
  assert.match(songHtml, /3\u00d7/);

  const artistHtml = statRows([{ artist: "AC/DC", count: 2 }], "artist");
  assert.match(artistHtml, /AC\/DC/);

  const reqHtml = statRows([{ name: "Dave", count: 1 }], "requester");
  assert.match(reqHtml, /Dave/);
});

test("paintStatsReactionList hides empty and paints reaction groups", () => {
  const wrap = { hidden: false };
  const listEl = { innerHTML: "x" };
  paintStatsReactionList(wrap, listEl, []);
  assert.equal(wrap.hidden, true);
  assert.equal(listEl.innerHTML, "");

  paintStatsReactionList(wrap, listEl, [
    {
      name: "Song",
      artist: "Band",
      count: 4,
      reactions: [{ kind: "fire", by: ["Dave"] }],
    },
  ]);
  assert.equal(wrap.hidden, false);
  assert.match(listEl.innerHTML, /Song/);
  assert.match(listEl.innerHTML, /Band/);
  assert.match(listEl.innerHTML, new RegExp(REACTION_EMOJI.fire));
  assert.match(listEl.innerHTML, /Dave/);
});

test("statsSummaryCardsHtml and dedicationsHtml escape content", () => {
  const cards = statsSummaryCardsHtml({
    total: 5,
    topSongs: [{ name: `<b>X</b>` }],
    topArtists: [{ artist: "Y" }],
    topRequesters: [{ name: "Z", count: 2 }],
  });
  assert.match(cards, /Requests: 5/);
  assert.match(cards, /Top song:/);
  assert.match(cards, /Top artist: Y/);
  assert.match(cards, /Top requestor: Z/);
  assert.doesNotMatch(cards, /<b>X<\/b>/);
  assert.match(cards, /&lt;b&gt;/);

  const wall = dedicationsHtml([
    {
      dedication: "Ann",
      requestedBy: "Bob",
      name: "Song",
      artist: "Artist",
    },
  ]);
  assert.match(wall, /Ann/);
  assert.match(wall, /Song/);
});

test("karaokeRowsHtml includes mic emoji and Mic'd by line", () => {
  const html = karaokeRowsHtml([
    { name: "Song", artist: "A", by: ["Dave"], count: 2 },
  ]);
  assert.match(html, new RegExp(REACTION_EMOJI.mic));
  assert.match(html, /Mic'd by/);
  assert.match(html, /Dave/);
});

test("displayTonightStatsHtml paints tonight highlights", () => {
  const html = displayTonightStatsHtml({
    tonight: {
      total: 12,
      topSongs: [{ name: "Thunderstruck", artist: "AC/DC", count: 3 }],
      topArtists: [{ artist: "AC/DC", count: 4 }],
      topRequesters: [{ name: "Maria", count: 5 }],
    },
  });
  assert.match(html, /Requests/);
  assert.match(html, />12</);
  assert.match(html, /Thunderstruck/);
  assert.match(html, /Maria/);
  assert.match(html, /5\u00d7/);
});

test("displayWindowStatsHtml paints all-time highlights", () => {
  const html = displayWindowStatsHtml({
    total: 88,
    topSongs: [{ name: "Africa", artist: "Toto", count: 9 }],
    topArtists: [{ artist: "Toto", count: 11 }],
    topRequesters: [{ name: "Dave", count: 20 }],
  });
  assert.match(html, />88</);
  assert.match(html, /Africa/);
  assert.match(html, /Dave/);
  assert.match(html, /20\u00d7/);
});

test("paintDisplayTonightStats fills tonight and all-time grids", () => {
  const tonightGrid = { innerHTML: "" };
  const allTimeGrid = { innerHTML: "" };
  paintDisplayTonightStats(
    { tonightGrid, allTimeGrid },
    {
      tonight: { total: 3, topRequesters: [{ name: "Maria", count: 2 }] },
      allTime: { total: 40, topRequesters: [{ name: "Dave", count: 12 }] },
    }
  );
  assert.match(tonightGrid.innerHTML, />3</);
  assert.match(tonightGrid.innerHTML, /Maria/);
  assert.match(allTimeGrid.innerHTML, />40</);
  assert.match(allTimeGrid.innerHTML, /Dave/);
});

test("statsEmptyMessage differs for tonight vs all-time", () => {
  assert.match(statsEmptyMessage("tonight"), /tonight/);
  assert.doesNotMatch(statsEmptyMessage("all"), /tonight/);
});
