import { test } from "node:test";
import assert from "node:assert/strict";
import { songCount, createPlaylistsUi } from "../public/js/playlists-ui.js";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

test("songCount pluralizes", () => {
  assert.equal(songCount(1), "1 song");
  assert.equal(songCount(0), "0 songs");
  assert.equal(songCount(3), "3 songs");
});

test("createPlaylistsUi exposes selection helpers", () => {
  const api = createPlaylistsUi(
    { randomButtons: [] },
    {
      hostFetch: async () => new Response("{}", { status: 200 }),
      showToast: () => {},
      confirmModal: async () => false,
      refreshSonos: () => {},
      syncToolbarMoodVisibility: () => {},
      updateMusicMixHubSummaries: () => {},
      syncAutoFillSelection: () => {},
      getGenreIds: () => [],
      getMoodId: () => null,
      getGenreBucketCount: () => 0,
    }
  );
  assert.deepEqual(api.getSelectedIds(), []);
  assert.deepEqual(api.getHubStats(), {
    total: 0,
    selected: 0,
    hasSelection: false,
  });
  assert.equal(typeof api.loadPlaylists, "function");
  assert.equal(typeof api.renderIfLoaded, "function");
});
