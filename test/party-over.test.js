// "Party's Over" lockdown: settings persistence, the 8-hour auto-expiry, and
// the ritual state exposure.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STORE = path.join(
  os.tmpdir(),
  `pq-party-over-${process.pid}-${Date.now()}.json`
);
process.env.PARTYQUEUE_SETTINGS_FILE = STORE;

let settings;
let rituals;

before(async () => {
  settings = await import("../src/settings.js");
  rituals = await import("../src/party-rituals.js");
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

test("partyOver defaults to off", () => {
  const c = settings.getContentSettings();
  assert.equal(c.partyOver, false);
  assert.equal(c.partyOverAt, 0);
  assert.equal(rituals.isPartyOver(), false);
});

test("setPartyOver stamps the start time and clears it on unlock", () => {
  const beforeMs = Date.now();
  const on = rituals.setPartyOver(true);
  assert.equal(on.partyOver, true);
  assert.ok(on.partyOverAt >= beforeMs);
  assert.equal(rituals.isPartyOver(), true);

  const off = rituals.setPartyOver(false);
  assert.equal(off.partyOver, false);
  assert.equal(off.partyOverAt, 0);
  assert.equal(rituals.isPartyOver(), false);
});

test("lockdown auto-expires after 8 hours and clears the stored flag", () => {
  rituals.setPartyOver(true);
  const startedAt = settings.getContentSettings().partyOverAt;

  const justUnderTtl = startedAt + settings.PARTY_OVER_TTL_MS - 1000;
  assert.equal(rituals.isPartyOver(justUnderTtl), true);

  const pastTtl = startedAt + settings.PARTY_OVER_TTL_MS + 1000;
  assert.equal(rituals.isPartyOver(pastTtl), false);
  // The expiry also resets the persisted flag, not just the answer.
  assert.equal(settings.getContentSettings().partyOver, false);
  assert.equal(rituals.isPartyOver(), false);
});

test("getRitualState reports partyOver", () => {
  rituals.setPartyOver(true);
  assert.equal(rituals.getRitualState().partyOver, true);
  rituals.setPartyOver(false);
  assert.equal(rituals.getRitualState().partyOver, false);
});
