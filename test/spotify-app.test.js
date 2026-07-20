import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(__dirname, "..", "data", "spotify-app.json");
const BAK = STORE + ".testbak";
const ENV_TEST = path.join(__dirname, "..", "data", "spotify-app.env.test");

let mod;

before(async () => {
  if (fs.existsSync(STORE)) fs.renameSync(STORE, BAK);
  else if (fs.existsSync(BAK)) fs.unlinkSync(BAK);
  process.env.PARTYQUEUE_ENV_FILE = ENV_TEST;
  if (fs.existsSync(ENV_TEST)) fs.unlinkSync(ENV_TEST);
  delete process.env.SPOTIFY_CLIENT_ID;
  delete process.env.SPOTIFY_CLIENT_SECRET;
  delete process.env.SPOTIFY_REDIRECT_URI;
  delete process.env.SPOTIFY_MARKET;
  mod = await import("../src/spotify-app.js");
});

after(() => {
  delete process.env.SPOTIFY_CLIENT_ID;
  delete process.env.SPOTIFY_CLIENT_SECRET;
  delete process.env.SPOTIFY_REDIRECT_URI;
  delete process.env.SPOTIFY_MARKET;
  delete process.env.PARTYQUEUE_ENV_FILE;
  if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
  if (fs.existsSync(BAK)) fs.renameSync(BAK, STORE);
  if (fs.existsSync(ENV_TEST)) fs.unlinkSync(ENV_TEST);
});

beforeEach(() => {
  delete process.env.SPOTIFY_CLIENT_ID;
  delete process.env.SPOTIFY_CLIENT_SECRET;
  delete process.env.SPOTIFY_REDIRECT_URI;
  delete process.env.SPOTIFY_MARKET;
  if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
  if (fs.existsSync(ENV_TEST)) fs.unlinkSync(ENV_TEST);
});

describe("cleanRedirectUri / cleanMarket", () => {
  it("accepts http(s) redirect URIs", () => {
    assert.equal(
      mod.cleanRedirectUri("http://127.0.0.1:8088/auth/callback"),
      "http://127.0.0.1:8088/auth/callback"
    );
    assert.equal(mod.cleanRedirectUri("ftp://x"), null);
  });

  it("normalizes market to two-letter uppercase", () => {
    assert.equal(mod.cleanMarket("us"), "US");
    assert.equal(mod.cleanMarket("USA"), null);
    assert.equal(mod.cleanMarket(""), null);
  });
});

describe("Spotify app settings store", () => {
  it("starts unconfigured", () => {
    const s = mod.getSpotifyAppStatus();
    assert.equal(s.configured, false);
    assert.equal(s.clientSecretSet, false);
  });

  it("saves credentials to .env and never exposes the secret", () => {
    const s = mod.setSpotifyAppSettings({
      clientId: "my-client-id",
      clientSecret: "super-secret-value",
      redirectUri: "http://127.0.0.1:8088/auth/callback",
      market: "ca",
    });
    assert.equal(s.configured, true);
    assert.equal(s.clientId, "my-client-id");
    assert.equal(s.clientSecretSet, true);
    assert.equal(s.market, "CA");
    assert.equal(JSON.stringify(s).includes("super-secret-value"), false);
    assert.equal(
      mod.getSpotifyAppCredentials().clientSecret,
      "super-secret-value"
    );
    assert.equal(process.env.SPOTIFY_CLIENT_ID, "my-client-id");
    const envText = fs.readFileSync(ENV_TEST, "utf8");
    assert.match(envText, /SPOTIFY_CLIENT_ID=my-client-id/);
    assert.match(envText, /SPOTIFY_CLIENT_SECRET=super-secret-value/);
  });

  it("keeps existing secret when a blank secret is posted", () => {
    mod.setSpotifyAppSettings({
      clientId: "id",
      clientSecret: "keep-me",
    });
    const s = mod.setSpotifyAppSettings({ clientId: "id", clientSecret: "   " });
    assert.equal(s.clientSecretSet, true);
    assert.equal(mod.getSpotifyAppCredentials().clientSecret, "keep-me");
  });

  it("clears stored credentials from env and disk", () => {
    mod.setSpotifyAppSettings({ clientId: "id", clientSecret: "x" });
    const s = mod.clearSpotifyAppSettings();
    assert.equal(s.configured, false);
    assert.equal(mod.getSpotifyAppCredentials().clientSecret, null);
    assert.equal(process.env.SPOTIFY_CLIENT_ID, undefined);
    const envText = fs.existsSync(ENV_TEST)
      ? fs.readFileSync(ENV_TEST, "utf8")
      : "";
    assert.equal(envText.includes("SPOTIFY_CLIENT_ID="), false);
  });
});
