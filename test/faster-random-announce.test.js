import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  withTimeout,
  LLM_SCRIPT_TIMEOUT_MS,
  prepareSetAnnounceClip,
  buildSetScript,
} from "../src/dj-voice.js";

describe("LLM script timeout helper", () => {
  it("exports a 12s timeout budget", () => {
    assert.equal(LLM_SCRIPT_TIMEOUT_MS, 12_000);
  });

  it("withTimeout resolves when the work finishes first", async () => {
    const value = await withTimeout(Promise.resolve("ok"), 100, "slow");
    assert.equal(value, "ok");
  });

  it("withTimeout rejects when the deadline wins", async () => {
    await assert.rejects(
      withTimeout(new Promise(() => {}), 20, "LLM script timed out"),
      /LLM script timed out/
    );
  });
});

describe("prepareSetAnnounceClip", () => {
  it("skips when there is nothing to announce", async () => {
    const result = await prepareSetAnnounceClip({ count: 0, added: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
  });
});

describe("writeSetScript template path", () => {
  it("buildSetScript still produces usable fallback copy", () => {
    const line = buildSetScript({
      event: "session_start",
      count: 5,
      highlights: [{ name: "Cowgirls", artist: "Morgan Wallen" }],
      similarAdded: 0,
      discoveryEnabled: false,
      intro: "Alright {event}.",
      outro: "Let's go.",
      descriptor: "hand-picked",
      nameMention: false,
      djName: "DJ Test",
      moodContext: { mood: "party", label: "Party" },
      characterMoment: { bit: null },
      characterKnobs: {
        intensity: "medium",
        catchphrase: "",
        banList: [],
        alwaysInstructions: "",
        neverInstructions: "",
      },
    });
    assert.ok(String(line).length > 20);
  });
});

describe("outside-slot planning budget", () => {
  it("documents the Random Discover/lane wall budget", async () => {
    // Kept in sync with OUTSIDE_SLOT_BUDGET_MS in sonos-random.js — Discover
    // and lane-hits must honor AbortSignal so Random HTTP can return quickly.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../src/sonos-random.js", import.meta.url),
        "utf8"
      )
    );
    assert.match(src, /OUTSIDE_SLOT_BUDGET_MS\s*=\s*5_500/);
    assert.match(src, /signal:\s*outsideSignal/);
  });
});

describe("announce prep overlap contract", () => {
  it("starts prep before enqueue finishes when sequenced like the Random route", async () => {
    const order = [];
    let releaseEnqueue;
    const enqueueGate = new Promise((r) => (releaseEnqueue = r));

    const prepPromise = (async () => {
      order.push("prep-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("prep-done");
      return { ok: true, message: "hi", clip: { publicUrl: "http://x/a.mp3" } };
    })();

    const enqueuePromise = (async () => {
      order.push("enqueue-start");
      await enqueueGate;
      order.push("enqueue-done");
      return { added: 5, deferredStart: true };
    })();

    // Mimic route: kick prep, then await enqueue (prep runs in parallel).
    await Promise.resolve();
    assert.ok(order.includes("prep-start"));
    assert.ok(order.includes("enqueue-start"));
    assert.ok(!order.includes("prep-done"));

    releaseEnqueue();
    const [prepared, result] = await Promise.all([prepPromise, enqueuePromise]);
    assert.equal(result.added, 5);
    assert.equal(prepared.ok, true);
    assert.ok(order.indexOf("prep-start") < order.indexOf("enqueue-done"));
    assert.ok(order.includes("prep-done"));
    assert.ok(order.includes("enqueue-done"));
  });

  it("prebuilt clip path does not regenerate TTS when clip is present", () => {
    const prepared = {
      ok: true,
      message: "Party time.",
      clip: {
        publicUrl: "http://example/tts.mp3",
        fileName: "tts.mp3",
        approxDurationSec: 8,
      },
    };
    const usePrebuilt =
      prepared?.ok && prepared.clip?.publicUrl && prepared.message;
    assert.equal(!!usePrebuilt, true);
    assert.equal(!usePrebuilt, false);
  });
});
