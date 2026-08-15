import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  queueSignature,
  registerQueueStreamRoutes,
} from "../src/queue-http.js";

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
}

test("queue signature changes only with queue tracks", () => {
  const tracks = [{ uri: "spotify:track:1", title: "One" }];
  assert.equal(
    queueSignature({ tracks, streamSequence: 1 }),
    queueSignature({ tracks, streamSequence: 99 })
  );
  assert.notEqual(queueSignature({ tracks }), queueSignature({ tracks: [] }));
});

test("queue signature ignores object key order but sees badge and edit fields", () => {
  const a = {
    uri: "spotify:track:1",
    title: "One",
    artist: "A",
    position: 2,
    itemId: "Q:1",
    searched: true,
    requestedBy: "Sam",
    dedication: "Jess",
    genreLane: "pop",
    genreLabel: "Pop",
    genreLanes: ["pop"],
    genreLabels: ["Pop"],
  };
  const b = {
    dedication: "Jess",
    genreLabels: ["Pop"],
    genreLanes: ["pop"],
    genreLabel: "Pop",
    genreLane: "pop",
    requestedBy: "Sam",
    searched: true,
    itemId: "Q:1",
    position: 2,
    artist: "A",
    title: "One",
    uri: "spotify:track:1",
  };
  assert.equal(queueSignature({ tracks: [a] }), queueSignature({ tracks: [b] }));

  assert.notEqual(
    queueSignature({ tracks: [a] }),
    queueSignature({ tracks: [{ ...a, dedication: "Pat" }] })
  );
  assert.notEqual(
    queueSignature({ tracks: [a] }),
    queueSignature({ tracks: [{ ...a, position: 3 }] })
  );
  assert.notEqual(
    queueSignature({ tracks: [a] }),
    queueSignature({ tracks: [{ ...a, fromPlaylist: true }] })
  );
  assert.notEqual(
    queueSignature({ tracks: [a] }),
    queueSignature({ tracks: [{ ...a, moodPick: true, mood: "80s" }] })
  );
  assert.notEqual(
    queueSignature({ tracks: [a] }),
    queueSignature({ tracks: [{ ...a, origin: "filler" }] })
  );
});

test("queue SSE route sends retained data and releases demand on close", () => {
  let route = null;
  let subscribers = 0;
  const monitor = {
    health: { status: "connected" },
    subscribe(listener) {
      subscribers += 1;
      listener({
        tracks: [{ uri: "spotify:track:1", title: "One" }],
        streamSession: "queue-test",
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
  const app = {
    get(path, handler) {
      assert.equal(path, "/api/queue/stream");
      route = handler;
    },
  };
  registerQueueStreamRoutes(app, { monitor });

  const req = new EventEmitter();
  const res = new FakeResponse();
  route(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/event-stream/);
  assert.match(res.output, /retry: 3000/);
  assert.match(res.output, /event: queue-status/);
  assert.match(res.output, /spotify:track:1/);
  assert.equal(subscribers, 1);

  req.emit("close");
  assert.equal(subscribers, 0);
});

