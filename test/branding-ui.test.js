import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  persistBrandingCache,
  BRANDING_STORAGE_KEY,
  normalizeBrandFontSize,
  applyBrandFontSizes,
  applyBrandCaps,
  applyBrandTypeForViewport,
  brandTypeForViewport,
  fillBrandFontSizeSelect,
  BRAND_FONT_PX,
} from "../public/js/branding-ui.js";

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

test("normalizeBrandFontSize accepts px values and clamps", () => {
  assert.equal(normalizeBrandFontSize(40, "header"), 40);
  assert.equal(normalizeBrandFontSize("22px", "subtitle"), 22);
  assert.equal(normalizeBrandFontSize(3, "version"), BRAND_FONT_PX.version.min);
  assert.equal(normalizeBrandFontSize(999, "header"), BRAND_FONT_PX.header.max);
  assert.equal(normalizeBrandFontSize("nope", "header"), BRAND_FONT_PX.header.default);
});

test("normalizeBrandFontSize maps legacy presets to px", () => {
  assert.equal(normalizeBrandFontSize("md", "header"), 36);
  assert.equal(normalizeBrandFontSize("lg", "header"), Math.round(36 * 1.2));
  assert.equal(normalizeBrandFontSize("sm", "version"), Math.round(11 * 0.85));
});

test("persistBrandingCache stores brand font sizes as px", () => {
  const storage = fakeStorage();
  persistBrandingCache(
    { headerFontSize: 40, subtitleFontSize: 14, versionFontSize: 12 },
    { storage }
  );
  const saved = JSON.parse(storage.getItem(BRANDING_STORAGE_KEY));
  assert.equal(saved.headerFontSize, 40);
  assert.equal(saved.subtitleFontSize, 14);
  assert.equal(saved.versionFontSize, 12);
});

test("applyBrandFontSizes sets CSS px variables", () => {
  const props = new Map();
  const fakeDoc = {
    documentElement: {
      style: {
        setProperty: (k, v) => props.set(k, v),
      },
    },
  };
  applyBrandFontSizes(
    { headerFontSize: 40, subtitleFontSize: 14, versionFontSize: 12 },
    { document: fakeDoc }
  );
  assert.equal(props.get("--pq-header-font-size"), "40px");
  assert.equal(props.get("--pq-subtitle-font-size"), "14px");
  assert.equal(props.get("--pq-version-font-size"), "12px");
});

test("applyBrandCaps toggles root classes", () => {
  const classes = new Set();
  const fakeDoc = {
    documentElement: {
      classList: {
        toggle: (name, on) => {
          if (on) classes.add(name);
          else classes.delete(name);
        },
      },
    },
  };
  applyBrandCaps(
    { headerAllCaps: true, subtitleAllCaps: false },
    { document: fakeDoc }
  );
  assert.ok(classes.has("pq-header-all-caps"));
  assert.ok(!classes.has("pq-subtitle-all-caps"));
});

test("brandTypeForViewport picks PC vs Phone type packs", () => {
  const brand = {
    headerFontSize: 40,
    subtitleFontSize: 18,
    versionFontSize: 11,
    headerAllCaps: true,
    subtitleAllCaps: true,
    headerFontSizeMobile: 28,
    subtitleFontSizeMobile: 14,
    versionFontSizeMobile: 10,
    headerAllCapsMobile: false,
    subtitleAllCapsMobile: false,
  };
  const desktop = brandTypeForViewport(brand, true);
  assert.equal(desktop.headerFontSize, 40);
  assert.equal(desktop.headerAllCaps, true);
  const phone = brandTypeForViewport(brand, false);
  assert.equal(phone.headerFontSize, 28);
  assert.equal(phone.subtitleFontSize, 14);
  assert.equal(phone.versionFontSize, 10);
  assert.equal(phone.headerAllCaps, false);
  assert.equal(phone.subtitleAllCaps, false);
});

test("applyBrandTypeForViewport applies phone pack when desktop=false", () => {
  const props = new Map();
  const classes = new Set();
  const fakeDoc = {
    documentElement: {
      style: { setProperty: (k, v) => props.set(k, v) },
      classList: {
        toggle: (name, on) => {
          if (on) classes.add(name);
          else classes.delete(name);
        },
      },
    },
  };
  applyBrandTypeForViewport(
    {
      headerFontSize: 40,
      subtitleFontSize: 18,
      versionFontSize: 11,
      headerAllCaps: true,
      subtitleAllCaps: true,
      headerFontSizeMobile: 28,
      subtitleFontSizeMobile: 14,
      versionFontSizeMobile: 10,
      headerAllCapsMobile: false,
      subtitleAllCapsMobile: false,
    },
    { document: fakeDoc, desktop: false }
  );
  assert.equal(props.get("--pq-header-font-size"), "28px");
  assert.equal(props.get("--pq-subtitle-font-size"), "14px");
  assert.equal(props.get("--pq-version-font-size"), "10px");
  assert.ok(!classes.has("pq-header-all-caps"));
  assert.ok(!classes.has("pq-subtitle-all-caps"));
});

test("fillBrandFontSizeSelect builds 1px options", () => {
  const options = [];
  /** @type {{ value: string, _html?: string }} */
  const select = { value: "" };
  Object.defineProperty(select, "innerHTML", {
    configurable: true,
    get() {
      return select._html || "";
    },
    set(html) {
      select._html = String(html);
      options.length = 0;
      for (const m of String(html).matchAll(/value="(\d+)"/g)) {
        options.push(Number(m[1]));
      }
    },
  });
  fillBrandFontSizeSelect(/** @type {any} */ (select), "version", 11);
  assert.equal(options[0], BRAND_FONT_PX.version.min);
  assert.equal(options[options.length - 1], BRAND_FONT_PX.version.max);
  assert.equal(select.value, "11");
  assert.ok(options.includes(12));
});
