import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(__dirname, "..", "data", "settings.json");
const BAK = STORE + ".p2testbak";

let settings;

before(async () => {
  if (fs.existsSync(STORE)) fs.renameSync(STORE, BAK);
  else if (fs.existsSync(BAK)) fs.unlinkSync(BAK);
  settings = await import("../src/settings.js");
  settings.bustSettingsCache();
});

after(() => {
  if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
  if (fs.existsSync(BAK)) fs.renameSync(BAK, STORE);
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
