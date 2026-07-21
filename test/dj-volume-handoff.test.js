import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginDjVolumeHandoff,
  createDjVolumeHandoff,
  getDjVolumeHandoffState,
  isDjClipUri,
  isRampSilenceUri,
  isRestoreSilenceUri,
} from "../src/dj-volume-handoff.js";

const PRE = "http://partyqueue/media/tts/silence-ramp-3s.mp3";
const DJ = "http://partyqueue/media/tts/tts-announce.mp3";
const POST = "http://partyqueue/media/tts/silence-3s.mp3";
const MUSIC = "spotify:track:next";

function fakeHandoff({
  timeline,
  baseline = 10,
  target = 30,
  states = null,
  now = () => 0,
  sleep = async () => {},
  setVolume = null,
  next = null,
} = {}) {
  let volume = baseline;
  let index = 0;
  const writes = [];
  const calls = [];
  const phases = [];
  const adapter = {
    async getNowPlaying() {
      const uri = timeline[Math.min(index, timeline.length - 1)];
      const state = states?.[Math.min(index, states.length - 1)] || "PLAYING";
      index += 1;
      calls.push(["now-playing", uri, state]);
      return { uri, state };
    },
    async getVolume() {
      calls.push(["read-volume", volume]);
      return volume;
    },
    async setVolume(level) {
      writes.push(level);
      calls.push(["set-volume", level]);
      if (setVolume) {
        const result = await setVolume(level, { volume, writes });
        if (result?.apply !== false) volume = level;
        return result?.result ?? { locked: true };
      }
      volume = level;
      return { locked: true };
    },
    async pause() {
      calls.push(["pause"]);
    },
    async resume() {
      calls.push(["resume"]);
    },
    async playAt(position) {
      calls.push(["play-at", position]);
    },
    async next() {
      calls.push(["next"]);
      if (next) await next();
    },
  };
  const logger = {
    info(message) {
      if (message.startsWith("phase ")) phases.push(message.slice(6));
    },
    warn() {},
    error() {},
  };
  const options = {
    publicUrl: DJ,
    approxDurationSec: 5,
    silenceSec: 3,
    calculateTarget: () => target,
    adapter,
    sleep,
    now,
    pollMs: 0,
    rampSteps: 6,
    ttsPosition: 2,
    musicPosition: 4,
    logger,
  };
  const handoff = createDjVolumeHandoff(options);
  return {
    handoff,
    options,
    writes,
    calls,
    phases,
    getVolume: () => volume,
  };
}

test("classifies pre-silence, DJ, and post-silence URIs", () => {
  assert.equal(isRampSilenceUri(PRE), true);
  assert.equal(isRestoreSilenceUri(PRE), false);
  assert.equal(isDjClipUri(PRE, DJ), false);
  assert.equal(isDjClipUri(DJ, DJ), true);
  assert.equal(isRestoreSilenceUri(POST), true);
  assert.equal(isDjClipUri(POST, DJ), false);
});

test("runs pre-silence → DJ → post-silence → music and restores exactly", async () => {
  const run = fakeHandoff({ timeline: [PRE, DJ, POST, MUSIC] });

  const result = await run.handoff.start();

  assert.equal(result.phase, "complete");
  assert.equal(result.baselineVolume, 10);
  assert.equal(run.getVolume(), 10);
  assert.deepEqual(run.phases, [
    "waiting-pre-silence",
    "ramping-up",
    "announcing",
    "ramping-down",
    "restoring",
    "restored",
    "complete",
  ]);
  assert.deepEqual(run.writes, [
    13, 17, 20, 23, 27, 30,
    27, 23, 20, 17, 13, 10,
    10,
  ]);
  const firstWrite = run.calls.findIndex(([name]) => name === "set-volume");
  const baselineRead = run.calls.findIndex(
    ([name, value]) => name === "read-volume" && value === 10
  );
  assert.ok(baselineRead >= 0 && baselineRead < firstWrite);
  const firstPause = run.calls.findIndex(([name]) => name === "pause");
  const firstAdvance = run.calls.findIndex(([name]) => name === "resume");
  assert.ok(firstPause >= 0 && firstPause < firstWrite);
  assert.ok(firstAdvance > run.calls.findIndex(
    ([name, value]) => name === "set-volume" && value === 30
  ));
});

test("missed post-silence pauses music, restores baseline, then resumes", async () => {
  const run = fakeHandoff({ timeline: [PRE, DJ, MUSIC] });

  await run.handoff.start();

  assert.equal(run.getVolume(), 10);
  const pauseAt = run.calls.findIndex(([name]) => name === "pause");
  const finalRestoreAt = run.calls.findLastIndex(
    ([name, value]) => name === "set-volume" && value === 10
  );
  const resumeAt = run.calls.findLastIndex(([name]) => name === "resume");
  assert.ok(pauseAt >= 0);
  assert.ok(finalRestoreAt > pauseAt);
  assert.ok(resumeAt > finalRestoreAt);
});

test("resumes a STOPPED silence pad and still restores baseline", async () => {
  const run = fakeHandoff({
    timeline: [PRE, DJ, POST, MUSIC],
    states: ["STOPPED", "PLAYING", "PLAYING", "PLAYING"],
  });

  await run.handoff.start();

  assert.equal(run.getVolume(), 10);
  assert.equal(run.calls.some(([name]) => name === "resume"), true);
});

test("advances a completed STOPPED DJ clip instead of replaying it", async () => {
  const run = fakeHandoff({
    timeline: [PRE, DJ, DJ, POST, MUSIC],
    states: ["PLAYING", "PLAYING", "STOPPED", "PLAYING", "PLAYING"],
  });

  await run.handoff.start();

  assert.deepEqual(
    run.calls
      .filter(([name]) => name === "play-at")
      .map(([, position]) => position),
    []
  );
  assert.equal(run.calls.filter(([name]) => name === "next").length, 2);
  assert.equal(run.getVolume(), 10);
});

test("retries a failed DJ advance without replaying the completed clip", async () => {
  let attempts = 0;
  const run = fakeHandoff({
    timeline: [PRE, DJ, DJ, DJ, POST, MUSIC],
    states: ["PLAYING", "PLAYING", "STOPPED", "STOPPED", "PLAYING", "PLAYING"],
    next: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient Sonos failure");
    },
  });

  await run.handoff.start();

  const nextCalls = run.calls
    .map(([name], index) => (name === "next" ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(nextCalls.length, 3);
  assert.equal(
    run.calls
      .slice(nextCalls[0] + 1, nextCalls[1])
      .some(([name]) => name === "resume"),
    false
  );
  assert.equal(run.getVolume(), 10);
});

test("holds a STOPPED post-silence until exact restore is complete", async () => {
  const run = fakeHandoff({
    timeline: [PRE, DJ, POST, MUSIC],
    states: ["PLAYING", "PLAYING", "STOPPED", "PLAYING"],
  });

  await run.handoff.start();

  const lastRestoreAt = run.calls.findLastIndex(
    ([name, value]) => name === "set-volume" && value === 10
  );
  const finalAdvanceAt = run.calls.findLastIndex(([name]) => name === "next");
  const finalResumeAt = run.calls.findLastIndex(([name]) => name === "resume");
  assert.equal(run.getVolume(), 10);
  assert.ok(finalAdvanceAt > lastRestoreAt);
  assert.ok(finalResumeAt > finalAdvanceAt);
});

test("retries a failed post-silence advance without wrapping to the DJ", async () => {
  let attempts = 0;
  const run = fakeHandoff({
    timeline: [PRE, DJ, POST, POST, MUSIC],
    next: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient Sonos failure");
    },
  });

  await run.handoff.start();

  assert.equal(run.calls.filter(([name]) => name === "next").length, 2);
  assert.equal(run.calls.filter(([name]) => name === "resume").length, 2);
  assert.equal(run.getVolume(), 10);
});

test("failed restore retries continue downward from the live volume", async () => {
  let failedBaselineWrites = 0;
  const run = fakeHandoff({
    timeline: [PRE, DJ, POST, POST, MUSIC],
    setVolume: async (level) => {
      if (level === 10 && failedBaselineWrites < 4) {
        failedBaselineWrites += 1;
        return { apply: false, result: { locked: false } };
      }
      return { result: { locked: true } };
    },
  });

  await run.handoff.start();

  const baselineWriteIndexes = run.writes
    .map((level, index) => (level === 10 ? index : -1))
    .filter((index) => index >= 0);
  const afterFailedPass = run.writes.slice(baselineWriteIndexes[3] + 1);
  assert.equal(failedBaselineWrites, 4);
  assert.ok(afterFailedPass.length > 0);
  assert.equal(Math.max(...afterFailedPass) <= 13, true);
  assert.equal(run.getVolume(), 10);
});

test("absolute deadline restores even while still on an announce pad", async () => {
  let currentTime = 0;
  const run = fakeHandoff({
    timeline: [PRE, PRE, MUSIC],
    now: () => {
      currentTime += 10_000;
      return currentTime;
    },
  });

  await run.handoff.start();

  assert.equal(run.getVolume(), 10);
  assert.equal(
    run.phases.includes("restoring") && run.phases.includes("restored"),
    true
  );
});

test("supersede cancellation restores the immutable pre-DJ baseline", async () => {
  let releaseSleep;
  const sleep = () =>
    new Promise((resolve) => {
      releaseSleep = resolve;
    });
  const run = fakeHandoff({ timeline: [PRE, DJ], sleep });
  run.handoff.start();

  for (let i = 0; i < 100 && !releaseSleep; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(typeof releaseSleep, "function");
  assert.equal(run.handoff.isVolumeLocked(), true);

  const cancelled = run.handoff.cancelAndRestore("superseded test");
  releaseSleep();
  assert.equal(await cancelled, true);
  assert.equal(run.getVolume(), 10);
  assert.equal(run.handoff.snapshot().phase, "cancelled");
});

test("failed supersede restore preserves the original baseline", async () => {
  let releaseSleep;
  let blockFirstSleep = true;
  let failBaselineRestore = false;
  const previous = fakeHandoff({
    timeline: [PRE, DJ],
    sleep: () => {
      if (!blockFirstSleep) return Promise.resolve();
      blockFirstSleep = false;
      return new Promise((resolve) => {
        releaseSleep = resolve;
      });
    },
    setVolume: async (level) => {
      if (failBaselineRestore && level === 10) {
        return { apply: false, result: { locked: false } };
      }
      return { result: { locked: true } };
    },
  });
  const active = await beginDjVolumeHandoff(previous.options);
  active.start();

  for (let i = 0; i < 100 && !releaseSleep; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(typeof releaseSleep, "function");
  assert.equal(previous.getVolume(), 30);

  failBaselineRestore = true;
  const nextRun = fakeHandoff({
    timeline: [PRE, DJ, POST, MUSIC],
    baseline: 40,
  });
  const nextPromise = beginDjVolumeHandoff(nextRun.options);
  releaseSleep();
  const next = await nextPromise;
  const result = await next.start();

  assert.equal(result.baselineVolume, 10);
  assert.equal(nextRun.getVolume(), 10);
});

test("terminal handoff releases global ownership", async () => {
  const run = fakeHandoff({ timeline: [PRE, DJ, POST, MUSIC] });
  const handoff = await beginDjVolumeHandoff(run.options);

  await handoff.start();

  assert.equal(getDjVolumeHandoffState().phase, "idle");
});
