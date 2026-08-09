import test from "node:test";
import assert from "node:assert/strict";
import { viewNameFromHash } from "../public/js/party-display-viewport.js";

test("viewNameFromHash strips Fully kiosk query", () => {
  assert.equal(viewNameFromHash("#/display?kiosk=1"), "display");
  assert.equal(viewNameFromHash("#/display?kiosk=true"), "display");
  assert.equal(viewNameFromHash("#/display&kiosk=1"), "display");
  assert.equal(viewNameFromHash("#/display"), "display");
  assert.equal(viewNameFromHash("#/"), "");
  assert.equal(viewNameFromHash("#/booth"), "booth");
});
