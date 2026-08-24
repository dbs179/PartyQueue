import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPartyRecapHtml,
  closingTimeHintText,
  closingTimeSongName,
  closingTimeToastMessage,
  createPartyRecapUi,
  shouldAnnounceClosingTime,
  shouldShowClosingRecapOverlay,
} from "../public/js/party-recap.js";

test("buildPartyRecapHtml renders totals and top lists", () => {
  const html = buildPartyRecapHtml({
    total: 1,
    topSongs: [{ name: "A", artist: "B", count: 2 }],
    topRequesters: [{ name: "Sam", count: 1 }],
  });
  assert.match(html, /1<\/span> request/);
  assert.match(html, /A — B/);
  assert.match(html, /Sam/);
});

test("buildPartyRecapHtml returns empty for missing payload", () => {
  assert.equal(buildPartyRecapHtml(null), "");
});

test("shouldAnnounceClosingTime skips stale and repeats", () => {
  const now = 1_000_000;
  assert.deepEqual(shouldAnnounceClosingTime(0, 0, now), {
    announce: false,
    nextLastShown: 0,
  });
  assert.deepEqual(shouldAnnounceClosingTime(500, 500, now), {
    announce: false,
    nextLastShown: 500,
  });
  assert.deepEqual(shouldAnnounceClosingTime(now - 70_000, 0, now), {
    announce: false,
    nextLastShown: now - 70_000,
  });
  assert.deepEqual(shouldAnnounceClosingTime(now - 10_000, 0, now), {
    announce: true,
    nextLastShown: now - 10_000,
  });
});

test("closing time copy names the song and drops beer emoji", () => {
  assert.equal(
    closingTimeSongName({ endOfNightName: "Closing Time" }, () => "Other"),
    "Closing Time"
  );
  assert.equal(closingTimeSongName(null, () => "Custom Nightcap"), "Custom Nightcap");
  assert.equal(closingTimeSongName(null, () => ""), "Closing Time");

  const toast = closingTimeToastMessage("Closing Time");
  assert.equal(toast, "Last call — no more requests. Closing Time is next.");
  assert.doesNotMatch(toast, /🍺|🍻/);
  assert.equal(closingTimeHintText("Custom Nightcap"), closingTimeToastMessage("Custom Nightcap"));
});

test("Party Display does not keep the Last call recap dialog", () => {
  assert.equal(shouldShowClosingRecapOverlay("display"), false);
  assert.equal(shouldShowClosingRecapOverlay("karaoke"), false);
  assert.equal(shouldShowClosingRecapOverlay("main"), true);
  assert.equal(shouldShowClosingRecapOverlay("booth"), true);

  const overlay = { hidden: false };
  const body = { innerHTML: "stale" };
  const toasts = [];
  const ui = createPartyRecapUi(
    {
      overlay,
      body,
      hintEl: { textContent: "" },
      titleEl: { textContent: "" },
      dismissBtn: null,
    },
    {
      showToast: (msg) => toasts.push(msg),
      getCurrentView: () => "display",
    }
  );
  ui.showPartyRecap({ total: 4, topSongs: [], topRequesters: [] });
  assert.equal(overlay.hidden, true);
  assert.equal(body.innerHTML, "stale");
  assert.equal(toasts.length, 1);
});

test("Karaoke Display also skips the Last call recap dialog", () => {
  const overlay = { hidden: false };
  const body = { innerHTML: "stale" };
  const toasts = [];
  const ui = createPartyRecapUi(
    {
      overlay,
      body,
      hintEl: { textContent: "" },
      titleEl: { textContent: "" },
      dismissBtn: null,
    },
    {
      showToast: (msg) => toasts.push(msg),
      getCurrentView: () => "karaoke",
    }
  );
  ui.showPartyRecap({ total: 4, topSongs: [], topRequesters: [] });
  assert.equal(overlay.hidden, true);
  assert.equal(toasts.length, 1);
});
