import { test } from "node:test";
import assert from "node:assert/strict";
import { createMusicMixUi } from "../public/js/music-mix-ui.js";

/** Minimal localStorage stub so factory init works outside the browser. */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

test("createMusicMixUi returns the mix API surface", () => {
  const api = createMusicMixUi(
    {},
    {
      hostFetch: async () => new Response("{}", { status: 200 }),
      showToast: () => {},
      navigateMixPanel: () => {},
      getPlaylistIds: () => [],
      getPlaylistHubStats: () => ({
        total: 0,
        selected: 0,
        hasSelection: false,
      }),
      setPlaylistIdsFromServer: () => {},
      renderPlaylistsIfLoaded: () => {},
      syncDiscoverFromServer: () => {},
      syncRotationFromServer: () => {},
      syncContentTogglesFromServer: () => {},
      isRandomBarConnected: () => false,
    }
  );
  for (const key of [
    "syncToolbarMoodVisibility",
    "activeEraMoodId",
    "currentGenreIds",
    "currentMoodId",
    "getGenreBucketCount",
    "syncAutoFillFromServer",
    "updateMixSelectionFromServer",
    "updateMixGenreHeaderFromServer",
    "applyGenresFromSettings",
    "loadGenres",
    "loadAutoFill",
    "setAutofillToggle",
    "updateMusicMixHubSummaries",
    "refreshPoolSizeHint",
    "syncPickerSelection",
    "syncAutoFillSelection",
  ]) {
    assert.equal(typeof api[key], "function", key);
  }
  assert.deepEqual(api.currentGenreIds(), []);
  assert.equal(api.getGenreBucketCount(), 0);
  assert.equal(api.currentMoodId(), null);
});
