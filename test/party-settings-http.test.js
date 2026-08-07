import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  partySettingsSignature,
  readPartySettingsSnapshot,
  registerPartySettingsRoutes,
} from "../src/party-settings-http.js";

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
  ]) {
    assert.ok(key in snap, `missing ${key}`);
  }
  assert.equal(typeof snap.neverEnding, "boolean");
  assert.equal(typeof snap.discoverEnabled, "boolean");
  assert.equal(typeof snap.partyOver, "boolean");
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
      routes.set(path, handler);
      if (path === "/api/party/stream") route = handler;
    },
  };
  registerPartySettingsRoutes(app, { monitor });

  assert.ok(routes.has("/api/party"));
  assert.ok(routes.has("/api/party/stream"));

  const httpRes = new FakeResponse();
  routes.get("/api/party")({}, httpRes);
  assert.equal(typeof httpRes.body.neverEnding, "boolean");

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
