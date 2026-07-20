import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(__dirname, "..", "data", "lastfm.json");
const BAK = STORE + ".testbak";
const ENV_TEST = path.join(__dirname, "..", "data", "lastfm.env.test");

let mod;

before(async () => {
  if (fs.existsSync(STORE)) fs.renameSync(STORE, BAK);
  else if (fs.existsSync(BAK)) fs.unlinkSync(BAK);
  process.env.PARTYQUEUE_ENV_FILE = ENV_TEST;
  if (fs.existsSync(ENV_TEST)) fs.unlinkSync(ENV_TEST);
  delete process.env.LASTFM_API_KEY;
  mod = await import("../src/lastfm.js");
});

after(() => {
  delete process.env.LASTFM_API_KEY;
  delete process.env.PARTYQUEUE_ENV_FILE;
  if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
  if (fs.existsSync(BAK)) fs.renameSync(BAK, STORE);
  if (fs.existsSync(ENV_TEST)) fs.unlinkSync(ENV_TEST);
});

beforeEach(() => {
  delete process.env.LASTFM_API_KEY;
  if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
  if (fs.existsSync(ENV_TEST)) fs.unlinkSync(ENV_TEST);
});

describe("Last.fm settings store", () => {
  it("starts unconfigured", () => {
    const s = mod.getLastfmStatus();
    assert.equal(s.configured, false);
    assert.equal(s.apiKeySet, false);
  });

  it("saves key to .env and never exposes it in status", () => {
    const s = mod.setLastfmSettings({ apiKey: "secret-lastfm-key" });
    assert.equal(s.configured, true);
    assert.equal(s.apiKeySet, true);
    assert.equal(JSON.stringify(s).includes("secret-lastfm-key"), false);
    assert.equal(mod.getLastfmApiKey(), "secret-lastfm-key");
    assert.equal(process.env.LASTFM_API_KEY, "secret-lastfm-key");
    const envText = fs.readFileSync(ENV_TEST, "utf8");
    assert.match(envText, /LASTFM_API_KEY=secret-lastfm-key/);
  });

  it("keeps existing key when a blank key is posted", () => {
    mod.setLastfmSettings({ apiKey: "keep-me" });
    const s = mod.setLastfmSettings({ apiKey: "   " });
    assert.equal(s.apiKeySet, true);
    assert.equal(mod.getLastfmApiKey(), "keep-me");
  });

  it("clears stored key from env and disk", () => {
    mod.setLastfmSettings({ apiKey: "x" });
    const s = mod.clearLastfmSettings();
    assert.equal(s.configured, false);
    assert.equal(mod.getLastfmApiKey(), "");
    assert.equal(process.env.LASTFM_API_KEY, undefined);
    const envText = fs.existsSync(ENV_TEST)
      ? fs.readFileSync(ENV_TEST, "utf8")
      : "";
    assert.equal(envText.includes("LASTFM_API_KEY="), false);
  });
});
