import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginDjVolumeHandoff,
  createDjVolumeHandoff,
  getDjVolumeHandoffState,
  handoffWatchSleepMs,
  HANDOFF_WATCH_MAX_FAILURES,
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
  fastVolume = false,
} = {}) {
  let volume = baseline;
  let index = 0;
  const writes = [];
  const fastWrites = [];
  const calls = [];
  const phases = [];
  const adapter = {
    async getNowPlaying() {
      const i = Math.min(index, timeline.length - 1);
      const uri = timeline[i];
      const state = states?.[i] || "PLAYING";
      calls.push(["now-playing", uri, state]);
      // Natural pad progress: ramp always drains; playing DJ drains once.
      // Restore stays sticky until next()/playAt so the post-advance guard
      // can re-read without consuming the first music track.
      if (isRampSilenceUri(uri) && index < timeline.length - 1) {
        index += 1;
      } else if (
        isDjClipUri(uri, DJ) &&
        (state === "PLAYING" || state === "TRANSITIONING") &&
        index < timeline.length - 1
      ) {
        index += 1;
      }
      const positionSec =
        isDjClipUri(uri, DJ) && state === "STOPPED"
          ? 8
          : isDjClipUri(uri, DJ)
            ? 2
            : 0;
      return { uri, state, positionSec };
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
      if (index < timeline.length - 1) index += 1;
    },
    async next() {
      calls.push(["next"]);
      // Advance only after a successful Next. From a DJ clip, jump to the
      // restore pad (skipping duplicate STOPPED DJ retries in the timeline).
      // From restore, skip duplicate restore entries used by retry tests.
      if (next) await next();
      const cur = timeline[Math.min(index, timeline.length - 1)];
      if (isDjClipUri(cur, DJ)) {
        const restoreIdx = timeline.findIndex(
          (uri, idx) => idx >= index && isRestoreSilenceUri(uri)
        );
        index =
          restoreIdx >= 0
            ? restoreIdx
            : Math.min(index + 1, timeline.length - 1);
      } else if (isRestoreSilenceUri(cur)) {
        let nextIdx = index + 1;
        while (
          nextIdx < timeline.length &&
          isRestoreSilenceUri(timeline[nextIdx])
        ) {
          nextIdx += 1;
        }
        index = Math.min(nextIdx, timeline.length - 1);
      } else if (index < timeline.length - 1) {
        index += 1;
      }
    },
  };
  // Opt-in only: the other tests here assert on the verified write sequence,
  // and the handoff falls back to setVolume when no fast set is offered.
  if (fastVolume) {
    adapter.setVolumeFast = async (level) => {
      fastWrites.push(level);
      calls.push(["set-volume-fast", level]);
      volume = level;
      return { volume: level };
    };
  }
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
    rampStepMs: 0,
    ttsPosition: 2,
    musicPosition: 4,
    logger,
  };
  const handoff = createDjVolumeHandoff(options);
  return {
    handoff,
    options,
    writes,
    fastWrites,
    calls,
    phases,
    getVolume: () => volume,
  };
}

test("DJ volume adapter uses raw pause, not host Pause", () => {
  const src = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/dj-volume-handoff.js"
    ),
    "utf8"
  );
  const adapter = src.match(/async function defaultAdapter\(\) \{[\s\S]*?\n\}/);
  assert.ok(adapter, "defaultAdapter should exist");
  assert.match(adapter[0], /pause:\s*sonos\.pausePlayback/);
  assert.doesNotMatch(adapter[0], /pause:\s*sonos\.pause,/);
});

test("DJ volume adapter reads a transport tick, not the full now-playing snapshot", () => {
  const src = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
      "dj-volume-handoff.js"
    ),
    "utf8"
  );
  const adapter = src.match(/async function defaultAdapter\(\) \{[\s\S]*?\n\}/);
  assert.ok(adapter, "defaultAdapter should exist");
  // getNowPlayingFresh pulls the entire queue while a silence pad is current,
  // which this loop would re-fetch several times a second.
  assert.match(adapter[0], /getNowPlaying:\s*sonos\.getTransportTick/);
  assert.doesNotMatch(adapter[0], /sonos\.getNowPlayingFresh/);
  assert.match(adapter[0], /setVolumeFast:\s*sonos\.setGroupVolumeFast/);
});

test("ramp verifies only its final step when a fast set is available", async () => {
  const run = fakeHandoff({
    timeline: [PRE, DJ, POST, MUSIC],
    fastVolume: true,
  });
  await run.handoff.start();

  // 10 -> 30 over 6 steps: the five intermediate levels go out unverified.
  assert.deepEqual(run.fastWrites.slice(0, 5), [13, 17, 20, 23, 27]);
  assert.ok(
    !run.fastWrites.includes(30),
    "the announce target must not be left unverified"
  );
  assert.ok(run.writes.includes(30), "announce target is a verified write");
  assert.ok(run.writes.includes(10), "restored baseline is a verified write");
  assert.equal(run.getVolume(), 10);
});

test("ramp stays fully verified when the adapter offers no fast set", async () => {
  const run = fakeHandoff({ timeline: [PRE, DJ, POST, MUSIC] });
  await run.handoff.start();

  assert.equal(run.fastWrites.length, 0);
  assert.ok(run.writes.includes(13), "every step goes through setVolume");
  assert.ok(run.writes.includes(30));
  assert.equal(run.getVolume(), 10);
});

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
  assert.equal(result.currentVolume, 10);
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
  // Pre-silence must not pause (that restarts TTS). Post-silence may hold so
  // the first music track isn't skipped by a late Next().
  const firstDjNp = run.calls.findIndex(
    ([name, uri]) => name === "now-playing" && uri === DJ
  );
  const firstPause = run.calls.findIndex(([name]) => name === "pause");
  assert.ok(firstDjNp >= 0);
  assert.ok(firstPause > firstDjNp, "must not pause before the DJ clip");
  assert.ok(
    run.calls.some(([name]) => name === "next" || name === "play-at"),
    "should advance from post-silence to music"
  );
});

test("does not pause pre-silence when Skip lands on the ramp pad early", async () => {
  // Mimics seekNearEnd → natural land on ramp while handoff is waiting.
  const run = fakeHandoff({
    timeline: [PRE, PRE, DJ, POST, MUSIC],
    states: ["PLAYING", "PLAYING", "PLAYING", "PLAYING", "PLAYING"],
  });

  await run.handoff.start();

  const firstDjNp = run.calls.findIndex(
    ([name, uri]) => name === "now-playing" && uri === DJ
  );
  const firstPause = run.calls.findIndex(([name]) => name === "pause");
  assert.ok(firstDjNp >= 0);
  assert.ok(
    firstPause === -1 || firstPause > firstDjNp,
    "pre-silence must keep playing while volume ramps up"
  );
  assert.equal(run.getVolume(), 10);
  assert.equal(run.phases.includes("announcing"), true);
});

test("recovers when seek-near-end skips the DJ clip onto restore silence", async () => {
  // Skip seek leaves ~1s of song + a draining ramp. Volume SOAP eats the rest
  // of the 3s pad; Sonos then skips the HTTP TTS onto restore. UI still shows
  // DJ Holy Roller (silence pads reuse the clip tagline) but nothing plays.
  const run = fakeHandoff({
    timeline: [PRE, POST, DJ, POST, MUSIC],
    states: ["PLAYING", "PLAYING", "PLAYING", "PLAYING", "PLAYING"],
  });

  const result = await run.handoff.start();

  assert.equal(result.phase, "complete");
  const playAts = run.calls
    .filter(([name]) => name === "play-at")
    .map(([, position]) => position);
  assert.ok(playAts.includes(2), "should SeekTrack the TTS clip");
  assert.ok(
    run.calls.some(([name, uri]) => name === "now-playing" && uri === DJ),
    "DJ clip should play after recovery"
  );
  assert.equal(run.getVolume(), 10);
});

test("recovers when seek-near-end skips the DJ clip onto music", async () => {
  const run = fakeHandoff({
    timeline: [PRE, MUSIC, DJ, POST, MUSIC],
    states: ["PLAYING", "PLAYING", "PLAYING", "PLAYING", "PLAYING"],
  });

  const result = await run.handoff.start();

  assert.equal(result.phase, "complete");
  assert.ok(
    run.calls.some(([name, position]) => name === "play-at" && position === 2),
    "should SeekTrack the TTS clip after music started too early"
  );
  assert.ok(
    run.calls.some(([name, uri]) => name === "now-playing" && uri === DJ),
    "DJ clip should play after recovery"
  );
  assert.equal(run.getVolume(), 10);
});

test("jumps to TTS when volume SOAP eats the ramp pad", async () => {
  // Natural song-end (no Skip): 6 SOAP volume steps often consume the 3s
  // ramp, then Sonos skips the HTTP TTS onto restore. Jump before that.
  let t = 0;
  const run = fakeHandoff({
    timeline: [PRE, PRE, DJ, POST, MUSIC],
    now: () => t,
    setVolume: async () => {
      t += 400;
      return { result: { locked: true } };
    },
  });

  const result = await run.handoff.start();

  assert.equal(result.phase, "complete");
  assert.ok(
    run.calls.some(([name, position]) => name === "play-at" && position === 2),
    "should SeekTrack TTS while the ramp pad still has a sliver left"
  );
  assert.ok(
    run.calls.some(([name, uri]) => name === "now-playing" && uri === DJ),
    "DJ clip should play after the pre-silence jump"
  );
  assert.equal(run.getVolume(), 10);
});

test("a TRANSITIONING DJ clip is not treated as played", async () => {
  // Sonos can flash TRANSITIONING on the TTS URI then skip it in ~150ms.
  // That is a failed start, not a finished announce.
  const run = fakeHandoff({
    timeline: [PRE, DJ, POST, DJ, POST, MUSIC],
    states: [
      "PLAYING",
      "TRANSITIONING",
      "PLAYING",
      "PLAYING",
      "PLAYING",
      "PLAYING",
    ],
  });

  const result = await run.handoff.start();

  assert.equal(result.phase, "complete");
  assert.ok(
    run.calls.some(([name, position]) => name === "play-at" && position === 2),
    "failed TRANSITIONING start should SeekTrack the TTS clip from restore"
  );
  assert.equal(run.getVolume(), 10);
});

test("does not Next past music if restore pad already advanced", async () => {
  // Restore expires into MUSIC during settle; a blind Next would skip it.
  const timeline = [PRE, DJ, POST];
  let index = 0;
  let volume = 10;
  const calls = [];
  const adapter = {
    async getNowPlaying() {
      // Polls: PRE → DJ → POST; later reads (advance guard) stay on MUSIC.
      const uri = index < timeline.length ? timeline[index] : MUSIC;
      if (index < timeline.length) index += 1;
      calls.push(["now-playing", uri, "PLAYING"]);
      return { uri, state: "PLAYING" };
    },
    async getVolume() {
      return volume;
    },
    async setVolume(level) {
      volume = level;
      calls.push(["set-volume", level]);
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
    },
  };
  const handoff = createDjVolumeHandoff({
    publicUrl: DJ,
    approxDurationSec: 5,
    silenceSec: 3,
    calculateTarget: () => 30,
    adapter,
    sleep: async () => {},
    now: () => 0,
    pollMs: 0,
    rampSteps: 6,
    ttsPosition: 2,
    musicPosition: 4,
    logger: { info() {}, warn() {}, error() {} },
  });

  await handoff.start();

  assert.equal(
    calls.filter(([name]) => name === "next").length,
    0,
    "must not Next after already landing on music"
  );
  assert.ok(calls.some(([name]) => name === "resume"));
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
  // Next from a STOPPED DJ clip must Play the following pad or the room
  // stays paused after the announce (Set Request / mid-set shouts).
  const firstNext = run.calls.findIndex(([name]) => name === "next");
  const resumeAfterDj = run.calls.findIndex(
    ([name], i) => i > firstNext && name === "resume"
  );
  assert.ok(firstNext >= 0);
  assert.ok(resumeAfterDj > firstNext);
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
  // First Next throws before resume; only the successful retry resumes.
  assert.equal(run.calls.filter(([name]) => name === "resume").length, 1);
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

test("later shout does not cancel an earlier volume handoff", async () => {
  let releaseSleep;
  const sleep = () =>
    new Promise((resolve) => {
      releaseSleep = resolve;
    });
  const first = fakeHandoff({
    timeline: [PRE, DJ, POST, MUSIC],
    sleep,
  });
  first.options.ttsPosition = 2;
  const active = await beginDjVolumeHandoff(first.options);
  active.start();

  for (let i = 0; i < 100 && !releaseSleep; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(typeof releaseSleep, "function");
  assert.equal(active.snapshot().cancelled, false);

  const later = fakeHandoff({ timeline: [PRE, DJ, POST, MUSIC] });
  later.options.ttsPosition = 8;
  const deferred = await beginDjVolumeHandoff(later.options);
  assert.equal(deferred.deferred, true);
  assert.equal(active.snapshot().cancelled, false);
  assert.notEqual(getDjVolumeHandoffState().phase, "cancelled");
  assert.notEqual(getDjVolumeHandoffState().phase, "idle");

  const cancelled = active.cancelAndRestore("test cleanup");
  releaseSleep();
  await cancelled;
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

test("holdPreSilence pauses the ramp until the announce clip is queued", async () => {
  let uri = PRE;
  let state = "PLAYING";
  const calls = [];
  let releaseSleep;
  const sleep = () =>
    new Promise((resolve) => {
      releaseSleep = resolve;
    });
  const adapter = {
    async getNowPlaying() {
      return { uri, state };
    },
    async getVolume() {
      return 10;
    },
    async setVolume() {
      return { locked: true };
    },
    async pause() {
      calls.push("pause");
      state = "PAUSED_PLAYBACK";
    },
    async resume() {
      calls.push("resume");
      state = "PLAYING";
    },
    async playAt() {},
    async next() {},
  };
  const phases = [];
  const handoff = createDjVolumeHandoff({
    publicUrl: DJ,
    holdPreSilence: true,
    approxDurationSec: 5,
    silenceSec: 3,
    calculateTarget: () => 30,
    adapter,
    sleep,
    now: () => 0,
    pollMs: 0,
    rampSteps: 2,
    ttsPosition: 2,
    musicPosition: 4,
    logger: {
      info(message) {
        if (message.startsWith("phase ")) phases.push(message.slice(6));
      },
      warn() {},
      error() {},
    },
  });

  const started = handoff.start();
  for (let i = 0; i < 50 && !releaseSleep; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(phases.includes("holding-pre-silence"));
  assert.ok(calls.includes("pause"));
  assert.equal(calls.includes("resume"), false);

  handoff.setTtsUrl(DJ);
  handoff.setPositions({ ttsPosition: 3, musicPosition: 5 });
  handoff.releasePreSilenceHold();
  const firstSleep = releaseSleep;
  releaseSleep = null;
  firstSleep();
  for (let i = 0; i < 50 && !phases.includes("announcing"); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(calls.includes("resume"));
  assert.ok(phases.includes("announcing"));

  const cancelled = handoff.cancelAndRestore("test cleanup");
  releaseSleep?.();
  await cancelled;
  await started.catch(() => {});
});

test("cancelling a pre-silence hold restores volume and resumes the room", async () => {
  // A shout that dies while we hold on the ramp must never leave the party
  // paused on 3s of silence.
  let uri = PRE;
  let state = "PLAYING";
  const calls = [];
  let volume = 10;
  let releaseSleep;
  const sleep = () =>
    new Promise((resolve) => {
      releaseSleep = resolve;
    });
  const adapter = {
    async getNowPlaying() {
      return { uri, state };
    },
    async getVolume() {
      return volume;
    },
    async setVolume(level) {
      volume = level;
      calls.push(`set-volume:${level}`);
      return { locked: true };
    },
    async pause() {
      calls.push("pause");
      state = "PAUSED_PLAYBACK";
    },
    async resume() {
      calls.push("resume");
      state = "PLAYING";
    },
    async playAt() {},
    async next() {},
  };
  const handoff = createDjVolumeHandoff({
    publicUrl: null,
    holdPreSilence: true,
    approxDurationSec: 45,
    silenceSec: 3,
    calculateTarget: () => 30,
    adapter,
    sleep,
    now: () => 0,
    pollMs: 0,
    rampSteps: 2,
    logger: { info() {}, warn() {}, error() {} },
  });

  const started = handoff.start();
  for (let i = 0; i < 50 && !calls.includes("pause"); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(calls.includes("pause"), "should hold on the ramp");
  assert.equal(handoff.heldPlayback, true);

  const cancelled = handoff.cancelAndRestore("empty shout script");
  releaseSleep?.();
  await cancelled;
  await started.catch(() => {});

  assert.equal(volume, 10, "baseline volume must be restored");
  assert.ok(calls.includes("resume"), "must resume playback after a held cancel");
  // Baseline goes back before the room is let go, so the song never starts loud.
  assert.ok(
    calls.lastIndexOf("set-volume:10") < calls.lastIndexOf("resume"),
    "restore should precede resume"
  );
  assert.equal(handoff.heldPlayback, false);
});

test("cancelling without a hold does not resume a paused room", async () => {
  const run = fakeHandoff({ timeline: [PRE, DJ, POST, MUSIC] });
  await run.handoff.start();
  const resumesBefore = run.calls.filter(([name]) => name === "resume").length;

  await run.handoff.cancelAndRestore("host paused");

  const resumesAfter = run.calls.filter(([name]) => name === "resume").length;
  assert.equal(resumesAfter, resumesBefore);
});

test("terminal handoff releases global ownership", async () => {
  const run = fakeHandoff({ timeline: [PRE, DJ, POST, MUSIC] });
  const handoff = await beginDjVolumeHandoff(run.options);

  await handoff.start();

  assert.equal(getDjVolumeHandoffState().phase, "idle");
});

test("handoffWatchSleepMs doubles until the cap", () => {
  assert.equal(handoffWatchSleepMs(0, 150), 150);
  assert.equal(handoffWatchSleepMs(1, 150), 300);
  assert.equal(handoffWatchSleepMs(2, 150), 600);
  assert.equal(handoffWatchSleepMs(5, 200), 5000);
});

test("handoff aborts after repeated watch failures instead of hammering", async () => {
  let polls = 0;
  const adapter = {
    async getNowPlaying() {
      polls += 1;
      const err = new Error("connect EHOSTUNREACH");
      err.code = "EHOSTUNREACH";
      throw err;
    },
    async getVolume() {
      return 10;
    },
    async setVolume() {
      return { locked: true };
    },
    async pause() {},
    async resume() {},
    async playAt() {},
    async next() {},
  };
  const errors = [];
  const handoff = createDjVolumeHandoff({
    publicUrl: DJ,
    calculateTarget: () => 30,
    adapter,
    sleep: async () => {},
    now: () => 0,
    pollMs: 0,
    logger: {
      info() {},
      warn() {},
      error(message) {
        errors.push(String(message));
      },
    },
  });

  const snap = await handoff.start();

  assert.equal(polls, HANDOFF_WATCH_MAX_FAILURES);
  assert.equal(snap.phase, "cancelled");
  assert.ok(errors.some((message) => /aborting volume handoff/.test(message)));
});
