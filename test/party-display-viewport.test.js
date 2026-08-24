import test from "node:test";
import assert from "node:assert/strict";
import {
  viewNameFromHash,
  fit16x9Stage,
  isTvStageView,
  karaokeDisplayFullyStartUrl,
  partyDisplayFullyStartUrl,
} from "../public/js/party-display-viewport.js";

test("viewNameFromHash strips Fully kiosk query", () => {
  assert.equal(viewNameFromHash("#/display?kiosk=1"), "display");
  assert.equal(viewNameFromHash("#/display?kiosk=true"), "display");
  assert.equal(viewNameFromHash("#/display&kiosk=1"), "display");
  assert.equal(viewNameFromHash("#/display"), "display");
  assert.equal(viewNameFromHash("#/karaoke?kiosk=1"), "karaoke");
  assert.equal(viewNameFromHash("#/karaoke?preview=1"), "karaoke");
  assert.equal(viewNameFromHash("#/"), "");
  assert.equal(viewNameFromHash("#/booth"), "booth");
});

test("viewNameFromHash strips TV preview query", () => {
  assert.equal(viewNameFromHash("#/display?preview=1"), "display");
  assert.equal(viewNameFromHash("#/display?preview=true"), "display");
  assert.equal(viewNameFromHash("#/display?tv=1"), "display");
  assert.equal(viewNameFromHash("#/display?preview=1&kiosk=1"), "display");
});

test("fit16x9Stage picks the largest 16:9 box inside the viewport", () => {
  // Portrait phone: width-limited.
  const phone = fit16x9Stage(390, 844);
  assert.equal(phone.w, 390);
  assert.ok(Math.abs(phone.h - 390 * (9 / 16)) < 0.01);

  // Landscape laptop already wider than 16:9: height-limited.
  const laptop = fit16x9Stage(1920, 900);
  assert.equal(laptop.h, 900);
  assert.ok(Math.abs(laptop.w - 900 * (16 / 9)) < 0.01);

  // Exact 16:9 fills the box.
  const exact = fit16x9Stage(1600, 900);
  assert.equal(exact.w, 1600);
  assert.equal(exact.h, 900);

  // Invalid → design default.
  assert.deepEqual(fit16x9Stage(0, 0), { w: 1920, h: 1080 });
});

test("partyDisplayFullyStartUrl appends the kiosk hash", () => {
  assert.equal(
    partyDisplayFullyStartUrl("http://10.10.1.30:8088/"),
    "http://10.10.1.30:8088/#/display?kiosk=1"
  );
  assert.equal(
    partyDisplayFullyStartUrl("http://10.10.1.30:8088"),
    "http://10.10.1.30:8088/#/display?kiosk=1"
  );
  assert.equal(
    partyDisplayFullyStartUrl("http://10.10.1.30:8088/join"),
    "http://10.10.1.30:8088/#/display?kiosk=1"
  );
  assert.equal(partyDisplayFullyStartUrl(""), "#/display?kiosk=1");
  assert.equal(partyDisplayFullyStartUrl("not a url"), "#/display?kiosk=1");
});

test("karaokeDisplayFullyStartUrl uses the karaoke kiosk hash", () => {
  assert.equal(isTvStageView("display"), true);
  assert.equal(isTvStageView("karaoke"), true);
  assert.equal(isTvStageView("main"), false);
  assert.equal(
    karaokeDisplayFullyStartUrl("http://10.10.1.30:8088/"),
    "http://10.10.1.30:8088/#/karaoke?kiosk=1"
  );
  assert.equal(karaokeDisplayFullyStartUrl(""), "#/karaoke?kiosk=1");
});
