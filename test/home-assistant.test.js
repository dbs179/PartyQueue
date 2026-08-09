import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(__dirname, "..", "data", "home-assistant.json");
const BAK = STORE + ".testbak";
const ENV_TEST = path.join(__dirname, "..", "data", "home-assistant.env.test");

let ha;

before(async () => {
  if (fs.existsSync(STORE)) fs.renameSync(STORE, BAK);
  else if (fs.existsSync(BAK)) fs.unlinkSync(BAK);
  process.env.PARTYQUEUE_ENV_FILE = ENV_TEST;
  if (fs.existsSync(ENV_TEST)) fs.unlinkSync(ENV_TEST);
  delete process.env.HA_URL;
  delete process.env.HA_TOKEN;
  delete process.env.HA_ALLOW_PUBLIC_URL;
  ha = await import("../src/home-assistant.js");
});

after(() => {
  delete process.env.HA_URL;
  delete process.env.HA_TOKEN;
  delete process.env.HA_ALLOW_PUBLIC_URL;
  delete process.env.PARTYQUEUE_ENV_FILE;
  if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
  if (fs.existsSync(BAK)) fs.renameSync(BAK, STORE);
  if (fs.existsSync(ENV_TEST)) fs.unlinkSync(ENV_TEST);
});

beforeEach(() => {
  delete process.env.HA_URL;
  delete process.env.HA_TOKEN;
  delete process.env.HA_ALLOW_PUBLIC_URL;
  if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
  if (fs.existsSync(ENV_TEST)) fs.unlinkSync(ENV_TEST);
});

describe("cleanHaUrl", () => {
  it("accepts private LAN / mDNS http(s) and strips trailing slashes", () => {
    assert.equal(ha.cleanHaUrl("http://homeassistant.local:8123/"), "http://homeassistant.local:8123");
    assert.equal(ha.cleanHaUrl("http://10.10.1.40:8123"), "http://10.10.1.40:8123");
    assert.equal(ha.cleanHaUrl("http://192.168.1.50:8123"), "http://192.168.1.50:8123");
    assert.equal(ha.cleanHaUrl("http://ha"), "http://ha");
    assert.equal(ha.cleanHaUrl("http://127.0.0.1:8123"), "http://127.0.0.1:8123");
  });

  it("accepts Nabu Casa HTTPS and opt-in public HTTPS", () => {
    assert.equal(
      ha.cleanHaUrl("https://abcdefgh.ui.nabu.casa"),
      "https://abcdefgh.ui.nabu.casa"
    );
    assert.equal(ha.cleanHaUrl("https://ha.example.com"), null);
    process.env.HA_ALLOW_PUBLIC_URL = "1";
    assert.equal(ha.cleanHaUrl("https://ha.example.com"), "https://ha.example.com");
  });

  it("rejects junk, metadata, link-local, and public http hosts", () => {
    assert.equal(ha.cleanHaUrl(""), null);
    assert.equal(ha.cleanHaUrl("not-a-url"), null);
    assert.equal(ha.cleanHaUrl("ftp://ha.local"), null);
    assert.equal(ha.cleanHaUrl("http://169.254.169.254/latest/meta-data"), null);
    assert.equal(ha.cleanHaUrl("http://169.254.1.1/"), null);
    assert.equal(ha.cleanHaUrl("http://8.8.8.8:8123"), null);
    assert.equal(ha.cleanHaUrl("http://evil.example:8123"), null);
    assert.equal(ha.cleanHaUrl("http://user:pass@10.0.0.5:8123"), null);
  });
});

describe("HA settings store", () => {
  it("starts unconfigured", () => {
    const s = ha.getHaStatus();
    assert.equal(s.configured, false);
    assert.equal(s.tokenSet, false);
    assert.equal(s.url, "");
  });

  it("saves url + token to .env and never exposes the token", () => {
    const s = ha.setHaSettings({
      url: "http://homeassistant.local:8123/",
      token: "secret-token-value",
    });
    assert.equal(s.configured, true);
    assert.equal(s.url, "http://homeassistant.local:8123");
    assert.equal(s.tokenSet, true);
    assert.equal(JSON.stringify(s).includes("secret-token-value"), false);
    assert.equal(ha.getHaCredentials().token, "secret-token-value");
    assert.equal(process.env.HA_URL, "http://homeassistant.local:8123");
    const envText = fs.readFileSync(ENV_TEST, "utf8");
    assert.match(envText, /HA_TOKEN=secret-token-value/);
  });

  it("keeps existing token when a blank token is posted", () => {
    ha.setHaSettings({ url: "http://ha.local:8123", token: "keep-me" });
    const s = ha.setHaSettings({ url: "http://ha.local:8123", token: "   " });
    assert.equal(s.tokenSet, true);
    assert.equal(ha.getHaCredentials().token, "keep-me");
  });

  it("clears stored credentials from env and disk", () => {
    ha.setHaSettings({ url: "http://ha.local:8123", token: "x" });
    const s = ha.clearHaSettings();
    assert.equal(s.configured, false);
    assert.equal(ha.getHaCredentials().token, null);
    assert.equal(process.env.HA_URL, undefined);
    const envText = fs.existsSync(ENV_TEST)
      ? fs.readFileSync(ENV_TEST, "utf8")
      : "";
    assert.equal(envText.includes("HA_TOKEN="), false);
  });

  it("rejects disallowed URLs and URL changes unless a new token is supplied", () => {
    ha.setHaSettings({ url: "http://ha.local:8123", token: "keep-secret" });
    assert.throws(
      () => ha.setHaSettings({ url: "http://evil.example:8123" }),
      /private LAN|allowed remote HA host/i
    );
    assert.throws(
      () => ha.setHaSettings({ url: "http://169.254.169.254/" }),
      /private LAN|allowed remote HA host/i
    );
    assert.equal(ha.getHaCredentials().url, "http://ha.local:8123");
    assert.equal(ha.getHaCredentials().token, "keep-secret");

    assert.throws(
      () => ha.setHaSettings({ url: "http://new-ha.local:8123" }),
      /requires entering the long-lived token/i
    );

    const s = ha.setHaSettings({
      url: "http://new-ha.local:8123",
      token: "fresh-token",
    });
    assert.equal(s.url, "http://new-ha.local:8123");
    assert.equal(ha.getHaCredentials().token, "fresh-token");
  });
});
