import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { persistBrandingCache, BRANDING_STORAGE_KEY } from "../public/js/branding-ui.js";

/** @type {Map<string, string>} */
let store;

beforeEach(() => {
  store = new Map();
});

afterEach(() => {
  store = null;
});

function fakeStorage() {
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      store.set(k, String(v));
    },
  };
}

test("persistBrandingCache merges partial updates", () => {
  const storage = fakeStorage();
  persistBrandingCache(
    { eventName: "Party", showVersion: true },
    { storage }
  );
  persistBrandingCache({ subtitle: "Tonight" }, { storage });
  const saved = JSON.parse(storage.getItem(BRANDING_STORAGE_KEY));
  assert.equal(saved.eventName, "Party");
  assert.equal(saved.subtitle, "Tonight");
  assert.equal(saved.showVersion, true);
});

test("persistBrandingCache clears heroBanner when null", () => {
  const storage = fakeStorage();
  persistBrandingCache({ heroBanner: "custom.png" }, { storage });
  persistBrandingCache({ heroBanner: null }, { storage });
  const saved = JSON.parse(storage.getItem(BRANDING_STORAGE_KEY));
  assert.equal(saved.heroBanner, null);
});

test("persistBrandingCache keeps heroBannerMobile independently", () => {
  const storage = fakeStorage();
  persistBrandingCache(
    { heroBanner: "desktop.png", heroBannerMobile: "phone.png" },
    { storage }
  );
  persistBrandingCache({ heroBannerMobile: null }, { storage });
  const saved = JSON.parse(storage.getItem(BRANDING_STORAGE_KEY));
  assert.equal(saved.heroBanner, "desktop.png");
  assert.equal(saved.heroBannerMobile, null);
});
