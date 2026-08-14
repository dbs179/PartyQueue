import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STORE = path.join(
  os.tmpdir(),
  `pq-party-http-${process.pid}-${Date.now()}.json`
);
process.env.PARTYQUEUE_SETTINGS_FILE = STORE;

let settings;
let applyPublicVibeToggles;
let partySettingsSignature;
let readPartySettingsSnapshot;
let registerPartySettingsRoutes;

before(async () => {
  settings = await import("../src/settings.js");
  settings.bustSettingsCache();
  await import("../src/autofill.js");
  await import("../src/party-rituals.js");
  ({
    applyPublicVibeToggles,
    partySettingsSignature,
    readPartySettingsSnapshot,
    registerPartySettingsRoutes,
  } = await import("../src/party-settings-http.js"));
});

after(() => {
  fs.rmSync(STORE, { recursive: true, force: true });
  delete process.env.PARTYQUEUE_SETTINGS_FILE;
  settings?.bustSettingsCache();
});

beforeEach(() => {
  if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
  settings.bustSettingsCache();
  settings.saveSettings({
    discoverEnabled: false,
    randomMoodEnabled: false,
    randomDecadeEnabled: false,
    filterExplicit: false,
    kidsLock: false,
    kidsLockSnapshot: null,
  });
  settings.bustSettingsCache();
});

test("party settings snapshot exposes guest-safe flags only", () => {
  const snap = readPartySettingsSnapshot();
  for (const key of [
    "neverEnding",
    "mixGenres",
    "mixMood",
    "discoverEnabled",
    "showQueueGenre",
    "randomMoodEnabled",
    "randomDecadeEnabled",
    "filterExplicit",
    "kidsLock",
    "requestsPaused",
    "partyOver",
    "hostControlsOnly",
    "closingTimeAt",
    "partyRecap",
    "sameArtistBatch",
    "nextSpecialSet",
  ]) {
    assert.ok(key in snap, `missing ${key}`);
  }
  assert.equal(typeof snap.neverEnding, "boolean");
  assert.equal(typeof snap.discoverEnabled, "boolean");
  assert.equal(typeof snap.partyOver, "boolean");
  assert.equal(typeof snap.sameArtistBatch?.enabled, "boolean");
  assert.equal(typeof snap.sameArtistBatch?.everyN, "number");
  assert.equal("pin" in snap, false);
  assert.equal("spotifyClientSecret" in snap, false);
});

test("party settings signature ignores stream metadata and senses flag changes", () => {
  const base = {
    neverEnding: true,
    mixGenres: ["folk", "pop"],
    mixMood: "80s",
    discoverEnabled: true,
    showQueueGenre: false,
    randomMoodEnabled: false,
    randomDecadeEnabled: false,
    filterExplicit: true,
    kidsLock: false,
    requestsPaused: false,
    partyOver: false,
    hostControlsOnly: false,
    closingTimeAt: null,
    partyRecap: null,
  };
  assert.equal(
    partySettingsSignature({ ...base, streamSequence: 1 }),
    partySettingsSignature({ ...base, streamSequence: 99 })
  );
  // Genre id order must not matter.
  assert.equal(
    partySettingsSignature({ ...base, mixGenres: ["pop", "folk"] }),
    partySettingsSignature(base)
  );
  assert.notEqual(
    partySettingsSignature(base),
    partySettingsSignature({ ...base, kidsLock: true })
  );
  assert.notEqual(
    partySettingsSignature(base),
    partySettingsSignature({ ...base, mixMood: "90s" })
  );
  assert.notEqual(
    partySettingsSignature(base),
    partySettingsSignature({
      ...base,
      sameArtistBatch: { enabled: true, everyN: 8, setsSince: 3 },
    })
  );
});

test("applyPublicVibeToggles updates Discover / rotation / filter without host PIN", () => {
  const applied = applyPublicVibeToggles({
    discoverEnabled: true,
    randomMoodEnabled: true,
    randomDecadeEnabled: true,
    filterExplicit: true,
    hostControlsOnly: true, // host-only — ignored
    requestsPaused: true, // booth ritual — ignored
  });
  assert.deepEqual(applied.sort(), [
    "discoverEnabled",
    "filterExplicit",
    "randomDecadeEnabled",
    "randomMoodEnabled",
  ]);
  assert.equal(settings.getDiscoverySettings().discoverEnabled, true);
  assert.equal(settings.getRotationSettings().randomMoodEnabled, true);
  assert.equal(settings.getRotationSettings().randomDecadeEnabled, true);
  assert.equal(settings.getContentSettings().filterExplicit, true);
  assert.equal(settings.getContentSettings().hostControlsOnly, false);
  assert.equal(settings.getContentSettings().requestsPaused, false);
});

test("applyPublicVibeToggles kidsLock uses the ritual path", () => {
  const applied = applyPublicVibeToggles({ kidsLock: true });
  assert.deepEqual(applied, ["kidsLock"]);
  assert.equal(settings.getContentSettings().kidsLock, true);
  assert.equal(settings.getContentSettings().filterExplicit, true);
  applyPublicVibeToggles({ kidsLock: false });
  assert.equal(settings.getContentSettings().kidsLock, false);
});

test("applyPublicVibeToggles returns empty for unknown keys", () => {
  assert.deepEqual(applyPublicVibeToggles({ songMemory: 99 }), []);
  assert.deepEqual(applyPublicVibeToggles({}), []);
});

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = {};
    this.statusCode = 0;
    this.output = "";
    this.writableEnded = false;
    this.destroyed = false;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }

  flushHeaders() {}

  write(value) {
    this.output += value;
  }

  end() {
    this.writableEnded = true;
  }

  json(body) {
    this.body = body;
  }
}

test("party SSE route sends retained data and releases demand on close", () => {
  let route = null;
  let subscribers = 0;
  const monitor = {
    health: { status: "connected" },
    subscribe(listener) {
      subscribers += 1;
      listener({
        neverEnding: true,
        discoverEnabled: false,
        streamSession: "party-test",
        streamSequence: 1,
      });
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers -= 1;
      };
    },
  };
  const routes = new Map();
  const app = {
    get(path, handler) {
      routes.set(`GET ${path}`, handler);
      if (path === "/api/party/stream") route = handler;
    },
    post(path, handler) {
      routes.set(`POST ${path}`, handler);
    },
  };
  registerPartySettingsRoutes(app, { monitor });

  assert.ok(routes.has("GET /api/party"));
  assert.ok(routes.has("POST /api/party"));
  assert.ok(routes.has("GET /api/party/stream"));

  const httpRes = new FakeResponse();
  routes.get("GET /api/party")({}, httpRes);
  assert.equal(typeof httpRes.body.neverEnding, "boolean");

  const postRes = new FakeResponse();
  routes.get("POST /api/party")(
    { body: { discoverEnabled: true } },
    postRes
  );
  assert.equal(postRes.body?.ok, true);
  assert.ok(postRes.body?.applied?.includes("discoverEnabled"));
  assert.equal(postRes.body?.discoverEnabled, true);

  const badRes = new FakeResponse();
  routes.get("POST /api/party")({ body: { songMemory: 12 } }, badRes);
  assert.equal(badRes.statusCode, 400);

  const req = new EventEmitter();
  const res = new FakeResponse();
  route(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/event-stream/);
  assert.match(res.output, /event: party-status/);
  assert.match(res.output, /neverEnding/);
  assert.equal(subscribers, 1);

  req.emit("close");
  assert.equal(subscribers, 0);
});
