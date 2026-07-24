import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isAllowedHostHeader } from "../src/http/host-guard.js";
import { imageMatchesMime } from "../src/image-signature.js";
import { admitSseClient, SSE_MAX_GLOBAL, SSE_MAX_PER_IP } from "../src/http/sse-limits.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pq-sec-"));
process.env.PARTYQUEUE_HOST_PIN_FILE = path.join(tmpDir, "host-pin.json");
process.env.PARTYQUEUE_HOST_BOOTSTRAP_FILE = path.join(tmpDir, "bootstrap.json");
delete process.env.SETTINGS_PIN;
const hostAuth = await import("../src/host-auth.js");

describe("host guard (DNS rebinding)", () => {
  const savedBase = process.env.PUBLIC_BASE_URL;
  const savedAllowed = process.env.PARTYQUEUE_ALLOWED_HOSTS;

  beforeEach(() => {
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.PARTYQUEUE_ALLOWED_HOSTS;
  });

  after(() => {
    if (savedBase != null) process.env.PUBLIC_BASE_URL = savedBase;
    else delete process.env.PUBLIC_BASE_URL;
    if (savedAllowed != null) process.env.PARTYQUEUE_ALLOWED_HOSTS = savedAllowed;
    else delete process.env.PARTYQUEUE_ALLOWED_HOSTS;
  });

  it("allows IP literals, localhost, single-label, and .local hosts", () => {
    assert.ok(isAllowedHostHeader("10.10.1.30:8088"));
    assert.ok(isAllowedHostHeader("192.168.1.5"));
    assert.ok(isAllowedHostHeader("[::1]:8080"));
    assert.ok(isAllowedHostHeader("localhost:3000"));
    assert.ok(isAllowedHostHeader("tower"));
    assert.ok(isAllowedHostHeader("partyqueue.local:8088"));
  });

  it("allows missing Host (non-browser clients)", () => {
    assert.ok(isAllowedHostHeader(""));
    assert.ok(isAllowedHostHeader(undefined));
  });

  it("blocks dotted public domains by default", () => {
    assert.ok(!isAllowedHostHeader("attacker.example.com"));
    assert.ok(!isAllowedHostHeader("rebind.evil.io:8088"));
  });

  it("allows the PUBLIC_BASE_URL hostname and PARTYQUEUE_ALLOWED_HOSTS entries", () => {
    process.env.PUBLIC_BASE_URL = "http://party.example.com:8088";
    assert.ok(isAllowedHostHeader("party.example.com:8088"));
    assert.ok(!isAllowedHostHeader("other.example.com"));

    process.env.PARTYQUEUE_ALLOWED_HOSTS = "queue.mytailnet.ts.net, other.example.com";
    assert.ok(isAllowedHostHeader("queue.mytailnet.ts.net"));
    assert.ok(isAllowedHostHeader("other.example.com:8088"));
  });
});

describe("image magic-byte validation", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(8),
  ]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]);
  const gif = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(8)]);
  const webp = Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    Buffer.alloc(4),
    Buffer.from("WEBP", "latin1"),
    Buffer.alloc(4),
  ]);

  it("accepts matching signatures", () => {
    assert.ok(imageMatchesMime(png, "image/png"));
    assert.ok(imageMatchesMime(jpeg, "image/jpeg"));
    assert.ok(imageMatchesMime(jpeg, "image/jpg"));
    assert.ok(imageMatchesMime(gif, "image/gif"));
    assert.ok(imageMatchesMime(webp, "image/webp"));
  });

  it("rejects mismatched or non-image bytes", () => {
    assert.ok(!imageMatchesMime(png, "image/jpeg"));
    assert.ok(!imageMatchesMime(Buffer.from("<script>alert(1)</script>"), "image/png"));
    assert.ok(!imageMatchesMime(Buffer.from("GIF89a"), "image/gif")); // too short
    assert.ok(!imageMatchesMime(png, "image/svg+xml"));
  });
});

describe("SSE admission caps", () => {
  function fakeRes() {
    return {
      statusCode: 0,
      headers: {},
      set(k, v) {
        this.headers[k] = v;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
  }

  it("admits under the caps and returns the client ip", () => {
    const clients = new Map();
    const ip = admitSseClient(clients, { ip: "10.0.0.9" }, fakeRes());
    assert.equal(ip, "10.0.0.9");
  });

  it("rejects one IP past the per-IP cap with 503", () => {
    const clients = new Map();
    for (let i = 0; i < SSE_MAX_PER_IP; i++) {
      clients.set({ id: i }, { ip: "10.0.0.9" });
    }
    const res = fakeRes();
    assert.equal(admitSseClient(clients, { ip: "10.0.0.9" }, res), null);
    assert.equal(res.statusCode, 503);
    // Other guests are unaffected.
    assert.equal(admitSseClient(clients, { ip: "10.0.0.10" }, fakeRes()), "10.0.0.10");
  });

  it("rejects everyone past the global cap", () => {
    const clients = new Map();
    for (let i = 0; i < SSE_MAX_GLOBAL; i++) {
      clients.set({ id: i }, { ip: `10.0.${i >> 8}.${i & 255}` });
    }
    const res = fakeRes();
    assert.equal(admitSseClient(clients, { ip: "10.9.9.9" }, res), null);
    assert.equal(res.statusCode, 503);
  });
});

describe("requireHostStrict (PIN-less installs stay locked)", () => {
  function fakeReqRes() {
    const res = {
      statusCode: 0,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    return { req: { get: () => "", headers: {} }, res };
  }

  before(() => {
    fs.rmSync(process.env.PARTYQUEUE_HOST_PIN_FILE, { force: true });
    hostAuth._bustHostPinCacheForTests();
    hostAuth._resetHostSessionsForTests();
    hostAuth._resetHostBootstrapForTests();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("denies with bootstrapRequired when no PIN is configured", () => {
    assert.equal(hostAuth.isHostPinConfigured(), false);
    const { req, res } = fakeReqRes();
    let called = false;
    hostAuth.requireHostStrict(req, res, () => {
      called = true;
    });
    assert.equal(called, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.bootstrapRequired, true);
  });

  it("passes with a valid session once a PIN is set", () => {
    const result = hostAuth.setHostPin("4321pin");
    assert.equal(result.ok, true);
    const token = hostAuth.createHostSession();
    const req = { get: (name) => (name === "x-partyqueue-host" ? token : ""), headers: {} };
    let called = false;
    hostAuth.requireHostStrict(req, { }, () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it("still denies a bad token when a PIN is set", () => {
    const { req, res } = fakeReqRes();
    let called = false;
    hostAuth.requireHostStrict(req, res, () => {
      called = true;
    });
    assert.equal(called, false);
    assert.equal(res.statusCode, 401);
  });
});
