import { test } from "node:test";
import assert from "node:assert/strict";
import { createGuestNameUi } from "../public/js/guest-name-ui.js";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

test("createGuestNameUi returns gate API and empty badge when unset", async () => {
  const api = createGuestNameUi({});
  assert.equal(typeof api.ensureDisplayName, "function");
  assert.equal(typeof api.guestBadgeName, "function");
  assert.equal(typeof api.guestIdentityPayload, "function");
  assert.equal(typeof api.syncGuestNameLabel, "function");
  const name = await api.ensureDisplayName();
  assert.equal(name, "");
  assert.equal(api.guestBadgeName(), "");
});
