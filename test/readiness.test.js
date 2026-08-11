import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluateReadiness,
  normalizeSonosStatus,
  probeDataWritable,
  sonosControlOk,
} from "../src/readiness.js";

describe("normalizeSonosStatus", () => {
  it("keeps known statuses and maps junk to unknown", () => {
    assert.equal(normalizeSonosStatus("connected"), "connected");
    assert.equal(normalizeSonosStatus("CONNECTING"), "connecting");
    assert.equal(normalizeSonosStatus("nope"), "unknown");
  });
});

describe("sonosControlOk", () => {
  it("accepts connected, connecting, or configured host", () => {
    assert.equal(sonosControlOk("connected", false), true);
    assert.equal(sonosControlOk("connecting", false), true);
    assert.equal(sonosControlOk("disconnected", true), true);
    assert.equal(sonosControlOk("disconnected", false), false);
    assert.equal(sonosControlOk("unknown", false), false);
  });
});

describe("probeDataWritable", () => {
  it("returns true for a writable temp directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pq-ready-"));
    assert.equal(probeDataWritable(dir), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns false when dataDir is an existing file", () => {
    const blocker = path.join(os.tmpdir(), `pq-ready-file-${process.pid}`);
    fs.writeFileSync(blocker, "x");
    try {
      assert.equal(probeDataWritable(blocker), false);
    } finally {
      fs.unlinkSync(blocker);
    }
  });
});

describe("evaluateReadiness", () => {
  const base = {
    version: "10.6.9",
    listening: true,
    shuttingDown: false,
    dataWritable: true,
    spotifyConfigured: true,
    sonosStatus: "connected",
    sonosHostConfigured: false,
  };

  it("is ready and partyReady when all party checks pass", () => {
    const r = evaluateReadiness(base);
    assert.equal(r.ready, true);
    assert.equal(r.partyReady, true);
    assert.equal(r.checks.dataWritable, true);
    assert.equal(r.checks.sonosOk, true);
  });

  it("stays ready for first-run without Spotify but not partyReady", () => {
    const r = evaluateReadiness({ ...base, spotifyConfigured: false });
    assert.equal(r.ready, true);
    assert.equal(r.partyReady, false);
  });

  it("fails ready when data is not writable", () => {
    const r = evaluateReadiness({ ...base, dataWritable: false });
    assert.equal(r.ready, false);
    assert.equal(r.partyReady, false);
  });

  it("fails ready while shutting down", () => {
    const r = evaluateReadiness({ ...base, shuttingDown: true });
    assert.equal(r.ready, false);
  });

  it("partyReady accepts configured Sonos host while disconnected", () => {
    const r = evaluateReadiness({
      ...base,
      sonosStatus: "disconnected",
      sonosHostConfigured: true,
    });
    assert.equal(r.ready, true);
    assert.equal(r.partyReady, true);
  });

  it("partyReady fails when Sonos is down and no host is configured", () => {
    const r = evaluateReadiness({
      ...base,
      sonosStatus: "disconnected",
      sonosHostConfigured: false,
    });
    assert.equal(r.ready, true);
    assert.equal(r.partyReady, false);
  });
});
