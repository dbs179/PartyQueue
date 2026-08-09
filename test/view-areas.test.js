import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSettingsArea,
  isMusicMixArea,
  isHostArea,
} from "../public/js/view-areas.js";

test("isSettingsArea matches settings hub and nested pages", () => {
  assert.equal(isSettingsArea("settings"), true);
  assert.equal(isSettingsArea("settings-dj"), true);
  assert.equal(isSettingsArea("settings-look"), true);
  assert.equal(isSettingsArea("booth"), false);
  assert.equal(isSettingsArea(""), false);
  assert.equal(isSettingsArea(null), false);
});

test("isMusicMixArea matches mix / mood / genres / playlists", () => {
  assert.equal(isMusicMixArea("mix"), true);
  assert.equal(isMusicMixArea("mood-presets"), true);
  assert.equal(isMusicMixArea("genres"), true);
  assert.equal(isMusicMixArea("playlists"), true);
  assert.equal(isMusicMixArea("main"), false);
  assert.equal(isMusicMixArea("settings"), false);
});

test("isHostArea covers booth, memory, suggestions, and settings", () => {
  assert.equal(isHostArea("booth"), true);
  assert.equal(isHostArea("memory"), true);
  assert.equal(isHostArea("suggestions"), true);
  assert.equal(isHostArea("settings"), true);
  assert.equal(isHostArea("settings-queue"), true);
  assert.equal(isHostArea("main"), false);
  assert.equal(isHostArea("mix"), false); // Vibe page — open without PIN
  assert.equal(isHostArea("stats"), false);
});
