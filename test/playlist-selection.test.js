import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  SELECTION_KEY,
  SELECTION_VERSION_KEY,
  SELECTION_VERSION,
  isDefaultUnchecked,
  loadPlaylistSelection,
  savePlaylistSelection,
  reconcilePlaylistSelection,
} from "../public/js/playlist-selection.js";

const memory = new Map();

beforeEach(() => {
  memory.clear();
  globalThis.localStorage = {
    getItem(key) {
      return memory.has(key) ? memory.get(key) : null;
    },
    setItem(key, value) {
      memory.set(key, String(value));
    },
    removeItem(key) {
      memory.delete(key);
    },
  };
});

test("isDefaultUnchecked is empty by default", () => {
  assert.equal(isDefaultUnchecked("Kids Party"), false);
});

test("load/save round-trip a Set of playlist ids", () => {
  assert.equal(loadPlaylistSelection(), null);
  savePlaylistSelection(new Set(["a", "b"]));
  assert.deepEqual([...loadPlaylistSelection()].sort(), ["a", "b"]);
  assert.ok(memory.get(SELECTION_KEY));
});

test("reconcile first run selects all playlists", () => {
  const playlists = [
    { id: "1", name: "Party" },
    { id: "2", name: "Chill" },
  ];
  const next = reconcilePlaylistSelection(playlists, null);
  assert.deepEqual([...next].sort(), ["1", "2"]);
  assert.equal(memory.get(SELECTION_VERSION_KEY), SELECTION_VERSION);
  assert.deepEqual([...loadPlaylistSelection()].sort(), ["1", "2"]);
});

test("reconcile with current version leaves selection alone", () => {
  memory.set(SELECTION_VERSION_KEY, SELECTION_VERSION);
  const playlists = [
    { id: "1", name: "Party" },
    { id: "2", name: "Chill" },
  ];
  const next = reconcilePlaylistSelection(playlists, new Set(["1"]));
  assert.deepEqual([...next], ["1"]);
});
