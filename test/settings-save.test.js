import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STORE = path.join(
  os.tmpdir(),
  `pq-settings-save-${process.pid}-${Date.now()}.json`
);
process.env.PARTYQUEUE_SETTINGS_FILE = STORE;

let settings;

before(async () => {
  settings = await import("../src/settings.js");
  settings.bustSettingsCache();
});

after(() => {
  fs.rmSync(STORE, { recursive: true, force: true });
  delete process.env.PARTYQUEUE_SETTINGS_FILE;
  settings?.bustSettingsCache();
});

beforeEach(() => {
  if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
  settings.bustSettingsCache();
});

test("saveSettings persists to disk and updates the cache", () => {
  settings.saveSettings({ songMemory: 42, eventName: "P2 Test" });
  assert.equal(settings.loadSettings().songMemory, 42);
  const disk = JSON.parse(fs.readFileSync(STORE, "utf8"));
  assert.equal(disk.songMemory, 42);
  assert.equal(disk.eventName, "P2 Test");
});

test("brand font sizes normalize and persist as pixels", () => {
  assert.equal(settings.getBrandingSettings().headerFontSize, 36);
  settings.setBrandingSettings({
    headerFontSize: "40px",
    subtitleFontSize: "nope",
    versionFontSize: "xl",
  });
  const brand = settings.getBrandingSettings();
  assert.equal(brand.headerFontSize, 40);
  assert.equal(brand.subtitleFontSize, 18);
  assert.equal(brand.versionFontSize, Math.round(11 * 1.4));
});

test("brand all-caps toggles default on and persist", () => {
  assert.equal(settings.getBrandingSettings().headerAllCaps, true);
  assert.equal(settings.getBrandingSettings().subtitleAllCaps, true);
  settings.setBrandingSettings({
    headerAllCaps: false,
    subtitleAllCaps: true,
  });
  const brand = settings.getBrandingSettings();
  assert.equal(brand.headerAllCaps, false);
  assert.equal(brand.subtitleAllCaps, true);
});

test("phone brand type falls back to desktop then persists independently", () => {
  settings.setBrandingSettings({
    headerFontSize: 40,
    headerAllCaps: false,
  });
  let brand = settings.getBrandingSettings();
  assert.equal(brand.headerFontSizeMobile, 40);
  assert.equal(brand.headerAllCapsMobile, false);

  settings.setBrandingSettings({
    headerFontSizeMobile: 28,
    headerAllCapsMobile: true,
    subtitleFontSizeMobile: 14,
    subtitleAllCapsMobile: false,
    versionFontSizeMobile: 10,
  });
  brand = settings.getBrandingSettings();
  assert.equal(brand.headerFontSize, 40);
  assert.equal(brand.headerAllCaps, false);
  assert.equal(brand.headerFontSizeMobile, 28);
  assert.equal(brand.headerAllCapsMobile, true);
  assert.equal(brand.subtitleFontSizeMobile, 14);
  assert.equal(brand.subtitleAllCapsMobile, false);
  assert.equal(brand.versionFontSizeMobile, 10);
});

test("heroBannerMobile falls back to desktop in resolveBannerForSlot", async () => {
  const banners = await import("../src/banners.js");
  banners.seedStarterBanners();
  assert.equal(banners.bannerExists("pc-banner-vinyl.jpg"), true);

  settings.setBrandingSettings({
    heroBanner: "pc-banner-vinyl.jpg",
    heroBannerMobile: null,
  });
  assert.equal(settings.getBrandingSettings().heroBanner, "pc-banner-vinyl.jpg");
  assert.equal(settings.getBrandingSettings().heroBannerMobile, null);
  assert.equal(settings.resolveBannerForSlot("desktop"), "pc-banner-vinyl.jpg");
  assert.equal(settings.resolveBannerForSlot("mobile"), "pc-banner-vinyl.jpg");

  if (banners.bannerExists("md-banner-speakers.jpg")) {
    settings.setBrandingSettings({
      heroBannerMobile: "md-banner-speakers.jpg",
    });
    assert.equal(
      settings.resolveBannerForSlot("mobile"),
      "md-banner-speakers.jpg"
    );
    assert.equal(
      settings.resolveBannerForSlot("desktop"),
      "pc-banner-vinyl.jpg"
    );
  }

  settings.setBrandingSettings({ heroBannerMobile: null });
  assert.equal(settings.resolveBannerForSlot("mobile"), "pc-banner-vinyl.jpg");
});

test("saveSettings throws when the path is not writable", () => {
  // Point the write at a directory named like the settings file so rename fails.
  if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
  fs.mkdirSync(STORE);
  settings.bustSettingsCache();
  assert.throws(() => settings.saveSettings({ songMemory: 7 }), /EISDIR|EPERM|ENOENT|EACCES/i);
  // Cache must not claim the failed write succeeded.
  settings.bustSettingsCache();
  const loaded = settings.loadSettings();
  assert.notEqual(loaded.songMemory, 7);
  fs.rmSync(STORE, { recursive: true, force: true });
});

test("request fairness defaults off and persists bounded controls", () => {
  assert.deepEqual(settings.getRequestFairnessSettings(), {
    requestFairnessEnabled: false,
    requestFairnessUpcomingThreshold: 5,
    requestFairnessUpcomingCap: 2,
    requestFairnessRollingMax: 5,
    requestFairnessWindowMinutes: 30,
    requestFairnessHostBypass: false,
  });

  const saved = settings.setRequestFairnessSettings({
    requestFairnessEnabled: true,
    requestFairnessUpcomingThreshold: 500,
    requestFairnessUpcomingCap: 0,
    requestFairnessRollingMax: 500,
    requestFairnessWindowMinutes: 15,
    requestFairnessHostBypass: false,
  });
  assert.deepEqual(saved, {
    requestFairnessEnabled: true,
    requestFairnessUpcomingThreshold: 100,
    requestFairnessUpcomingCap: 1,
    requestFairnessRollingMax: 100,
    requestFairnessWindowMinutes: 15,
    requestFairnessHostBypass: false,
  });
});

test("Discover is enabled once on upgrade, then respects the host choice", () => {
  settings.saveSettings({ discoverEnabled: false });
  assert.equal(settings.getDiscoverySettings().discoverEnabled, true);

  let disk = JSON.parse(fs.readFileSync(STORE, "utf8"));
  assert.equal(disk.discoverEnabled, true);
  assert.equal(disk.discoveryDefaultVersion, 1);

  settings.setDiscoverySettings({ discoverEnabled: false });
  assert.equal(settings.getDiscoverySettings().discoverEnabled, false);
  disk = JSON.parse(fs.readFileSync(STORE, "utf8"));
  assert.equal(disk.discoveryDefaultVersion, 1);
});

test("rotation settings default off with full pools", () => {
  assert.deepEqual(settings.getRotationSettings(), {
    randomMoodEnabled: false,
    randomDecadeEnabled: false,
    randomMoodEverySets: 1,
    randomDecadeEverySets: 1,
    randomMoodPool: ["party", "chill", "country", "heavy", "rap"],
    randomDecadePool: ["60s", "70s", "80s", "90s", "2000s", "2010s", "2020s"],
  });
});

test("rotation cadence clamps to 1-20 and pools are sanitized", () => {
  const saved = settings.setRotationSettings({
    randomMoodEnabled: true,
    randomMoodEverySets: 500,
    randomDecadeEverySets: 0,
    randomMoodPool: ["Party", "party", 42, "  CHILL  "],
    randomDecadePool: [],
  });
  assert.equal(saved.randomMoodEnabled, true);
  assert.equal(saved.randomMoodEverySets, 20);
  assert.equal(saved.randomDecadeEverySets, 1);
  // Lowercased, deduped, non-strings dropped.
  assert.deepEqual(saved.randomMoodPool, ["party", "chill"]);
  // An explicitly empty pool sticks (rotation just skips it).
  assert.deepEqual(saved.randomDecadePool, []);

  // Partial updates leave the other keys alone.
  const next = settings.setRotationSettings({ randomDecadeEnabled: true });
  assert.equal(next.randomMoodEverySets, 20);
  assert.deepEqual(next.randomMoodPool, ["party", "chill"]);
  assert.equal(next.randomDecadeEnabled, true);
});

test("setSonosPlayerType persists known types and rejects junk", () => {
  assert.deepEqual(settings.getSonosPlayerTypes(), {});
  const saved = settings.setSonosPlayerType("Kitchen", "Arc");
  assert.equal(saved.room, "Kitchen");
  assert.equal(saved.type, "arc");
  assert.equal(settings.getSonosPlayerTypeForRoom("kitchen"), "arc");

  // Case-insensitive room replace keeps a single key.
  settings.setSonosPlayerType("KITCHEN", "move");
  assert.deepEqual(settings.getSonosPlayerTypes(), { Kitchen: "move" });

  assert.throws(() => settings.setSonosPlayerType("Den", "boombox"), /Unknown/);
  assert.throws(() => settings.setSonosPlayerType("", "arc"), /Missing/);
});
