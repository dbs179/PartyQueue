import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashForView,
  resolveViewName,
  searchBackAction,
  withSearchOverlayState,
  isSearchOverlayState,
} from "../public/js/view-nav.js";

test("hashForView uses #/ for main", () => {
  assert.equal(hashForView("main"), "#/");
  assert.equal(hashForView(""), "#/");
  assert.equal(hashForView("booth"), "#/booth");
  assert.equal(hashForView("display", "preview=1"), "#/display?preview=1");
});

test("resolveViewName aliases old hashes", () => {
  const views = { main: 1, booth: 1, mix: 1, display: 1, karaoke: 1 };
  assert.equal(resolveViewName("#/", views), "main");
  assert.equal(resolveViewName("#/booth", views), "booth");
  assert.equal(resolveViewName("#/settings", views), "booth");
  assert.equal(resolveViewName("#/options", views), "booth");
  assert.equal(resolveViewName("#/mood", views), "mix");
  assert.equal(resolveViewName("#/display?kiosk=1", views), "display");
  assert.equal(resolveViewName("#/karaoke?kiosk=1", views), "karaoke");
  assert.equal(resolveViewName("#/nope", views), "main");
});

test("searchBackAction keeps home when search is open", () => {
  assert.equal(
    searchBackAction({
      currentView: "main",
      nextView: "booth",
      searchOpen: true,
    }),
    "restore-main"
  );
  assert.equal(
    searchBackAction({
      currentView: "main",
      nextView: "main",
      searchOpen: true,
    }),
    "close-only"
  );
  assert.equal(
    searchBackAction({
      currentView: "main",
      nextView: "booth",
      searchOpen: false,
    }),
    "navigate"
  );
  assert.equal(
    searchBackAction({
      currentView: "stats",
      nextView: "main",
      searchOpen: true,
    }),
    "navigate"
  );
});

test("withSearchOverlayState keeps the previous view markers", () => {
  const next = withSearchOverlayState({
    pq: 1,
    view: "main",
    pqFrom: "stats",
  });
  assert.equal(next.pqSearch, true);
  assert.equal(next.view, "main");
  assert.equal(next.pqFrom, "stats");
  assert.equal(isSearchOverlayState(next), true);
  assert.equal(isSearchOverlayState({ pq: 1, view: "main" }), false);
});
