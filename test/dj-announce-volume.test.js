import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  announceVolumeAt,
  inheritAnnounceMusicBaseline,
  lastAnnounceMusicBaseline,
  resetAnnounceVolumeForTests,
  resolveAnnounceClipDuration,
  observePostDriverTransport,
  runAnnounceVolume,
  uriMatchesClip,
  ANNOUNCE_PHASE,
  ANNOUNCE_MIN_POLL_MS,
  announceWatchSleepMs,
  scheduleAnnounceVolume,
  estimateAnnouncePlayhead,
  markAnnouncePlaybackImminent,
} from "../src/dj-announce-volume.js";
import {
  isDjVolumeHandoffActive,
  isDjVolumeHandoffArmed,
  setDjVolumeHandoffActive,
  setDjVolumeHandoffArmed,
} from "../src/dj-volume-handoff-state.js";
import {
  isPlayerSkipped,
  resetSpeakerReachabilityForTests,
} from "../src/sonos-reachability.js";

afterEach(() => {
  setDjVolumeHandoffArmed(false);
  setDjVolumeHandoffActive(false);
  resetAnnounceVolumeForTests();
  // Volume timeouts now cool a speaker off household-wide, so a test that
  // wedges one must not leave it skipped for the next.
  resetSpeakerReachabilityForTests();
});

const CLIP = "http://pq.local:8088/media/tts/dj-announce-abc123.mp3";

// 3s ramp, 18s speech, 3s restore: music 8, announce 20.
const shape = {
  durationSec: 24,
  rampSec: 3,
  restoreSec: 3,
  musicVolume: 8,
  announceVolume: 20,
};

const at = (positionSec) => announceVolumeAt({ ...shape, positionSec });

test("speech coasts the playhead poll and the silence edges stay tight", () => {
  // Waiting for a clip that has not started: slow, until Play is imminent.
  assert.equal(
    announceWatchSleepMs({ sawClip: false, waitMs: 1000, pollMs: 150 }),
    1000
  );
  assert.equal(
    announceWatchSleepMs({
      sawClip: false,
      imminent: true,
      waitMs: 1000,
      pollMs: 150,
    }),
    150
  );
  // Opening silence: tight, so the boost lands before the DJ speaks.
  assert.equal(
    announceWatchSleepMs({ sawClip: true, positionSec: 1, ...shape, pollMs: 150 }),
    150
  );
  // Mid-speech: coasting, because the level does not move here.
  assert.equal(
    announceWatchSleepMs({ sawClip: true, positionSec: 12, ...shape, pollMs: 150 }),
    1000
  );
  // Approaching the closing silence: aimed at it, not stepped past it.
  assert.equal(
    announceWatchSleepMs({ sawClip: true, positionSec: 20.9, ...shape, pollMs: 150 }),
    100
  );
  // An unknown clip length has no boundary to aim at.
  assert.equal(
    announceWatchSleepMs({
      sawClip: true,
      positionSec: 12,
      ...shape,
      durationSec: 0,
      pollMs: 150,
    }),
    150
  );
});

test("no sleep can carry the loop past the start of the closing silence", () => {
  // The dangerous direction is a late restore: the next song would open at
  // announce volume. Walk the whole clip and assert no sleep ever overshoots
  // the boundary by more than the floor on the final approach.
  for (const pads of [3, 4]) {
    const clip = { durationSec: 24, rampSec: pads, restoreSec: pads };
    const restoreStart = clip.durationSec - pads;
    const slackSec = ANNOUNCE_MIN_POLL_MS / 1000;
    for (let pos = 0; pos < restoreStart; pos += 0.01) {
      const sleepMs = announceWatchSleepMs({
        sawClip: true,
        positionSec: pos,
        ...clip,
        pollMs: 150,
      });
      const landsAt = pos + sleepMs / 1000;
      assert.ok(
        landsAt <= restoreStart + slackSec + 1e-9,
        `pad ${pads}s: sleeping ${sleepMs}ms at ${pos.toFixed(2)}s lands at ` +
          `${landsAt.toFixed(3)}s, past the ${restoreStart}s boundary`
      );
    }
  }
});

test("a coordinator transport sample can be waited on without another SOAP call", async () => {
  const { waitForCoordinatorTransport, resetAnnounceNowPlayingHoldForTests } =
    await import("../src/sonos-snapshots.js");
  resetAnnounceNowPlayingHoldForTests();
  const pending = waitForCoordinatorTransport({ after: 0, timeoutMs: 40 });
  const sample = await pending;
  assert.equal(sample, null);
});

test("a full announce hits both edges with a fraction of the playhead reads", async () => {
  const pads = 4;
  const clip = { durationSec: 26, rampSec: pads, restoreSec: pads };
  const restoreStart = clip.durationSec - pads;
  let clock = 0;
  let reads = 0;
  const events = [];
  const io = {
    mono: () => clock,
    now: () => clock,
    read: async () => {
      reads += 1;
      return {
        uri: CLIP,
        positionSec: clock / 1000,
        durationSec: clip.durationSec,
        state: "PLAYING",
        queueTrack: 1,
        observedAt: clock,
      };
    },
    setVolume: async (level) => events.push({ level, at: clock / 1000 }),
    sleep: async (ms) => {
      clock += ms;
    },
  };
  const result = await runAnnounceVolume(
    { clipUrl: CLIP, ...clip, musicVolume: 8, announceVolume: 20 },
    io,
    { pollMs: 150, maxMs: 60_000, logger: { debug() {}, warn() {}, error() {} } }
  );

  assert.equal(result.reason, "complete");
  const boost = events.find((event) => event.level === 20);
  assert.ok(
    boost && boost.at < pads,
    `boost must land inside the opening silence, got ${boost?.at}s`
  );
  const restore = events.find((event) => event.level === 8 && event.at > pads);
  assert.ok(
    restore && restore.at >= restoreStart && restore.at < clip.durationSec,
    `restore must land inside the closing silence, got ${restore?.at}s`
  );
  // Polling the whole clip at 150ms would be ~150 reads. Coasting through
  // speech is what keeps a busy night's shouts off the coordinator.
  assert.ok(reads < 60, `too many playhead reads for one announce: ${reads}`);
});

test("opening silence publishes the announce level immediately", () => {
  assert.equal(at(0).phase, ANNOUNCE_PHASE.ramp);
  assert.equal(at(0).volume, 20);
  assert.equal(at(1.5).volume, 20);
  assert.equal(at(1.5).phase, ANNOUNCE_PHASE.ramp);
});

test("volume is already at the announce level before the DJ speaks", () => {
  // The pad is 3s, so by 3s in — the moment speech starts — we must be there.
  assert.deepEqual(at(3), {
    phase: ANNOUNCE_PHASE.hold,
    volume: 20,
    progress: 1,
  });
  assert.equal(at(12).volume, 20);
  assert.equal(at(20.9).volume, 20);
});

test("closing silence publishes the music level immediately", () => {
  assert.equal(at(21).phase, ANNOUNCE_PHASE.restore);
  assert.equal(at(21).volume, 8);
  assert.equal(at(22.5).volume, 8);
  assert.deepEqual(at(24), {
    phase: ANNOUNCE_PHASE.done,
    volume: 8,
    progress: 1,
  });
});

test("a clip too short for both pads still ends at the music level", () => {
  // 4s clip with 3s pads each way: the ramps overlap.
  const short = {
    durationSec: 4,
    rampSec: 3,
    restoreSec: 3,
    musicVolume: 8,
    announceVolume: 20,
  };
  const end = announceVolumeAt({ ...short, positionSec: 3.9 });
  assert.equal(end.phase, ANNOUNCE_PHASE.restore);
  assert.ok(end.volume < 20, `expected below announce level, got ${end.volume}`);
  assert.equal(announceVolumeAt({ ...short, positionSec: 4 }).volume, 8);
});

test("volumes stay within Sonos range even with silly inputs", () => {
  const wild = announceVolumeAt({
    positionSec: 1,
    durationSec: 10,
    rampSec: 2,
    restoreSec: 2,
    musicVolume: -50,
    announceVolume: 400,
  });
  assert.ok(wild.volume >= 0 && wild.volume <= 100);
});

test("a proxied or query-suffixed URI still matches the clip", () => {
  assert.ok(uriMatchesClip(CLIP, CLIP));
  assert.ok(
    uriMatchesClip(
      "x-rincon-mp3radio://ha.local/api/tts_proxy/dj-announce-abc123.mp3?x=1",
      CLIP
    )
  );
  assert.ok(!uriMatchesClip("x-sonos-spotify:spotify:track:xyz", CLIP));
  assert.ok(!uriMatchesClip("", CLIP));
});

/** Scripted playhead: each tick yields the next [uri, positionSec] pair. */
function fakeIo(steps) {
  const volumes = [];
  const reads = { count: 0 };
  let i = 0;
  const step = () => steps[Math.min(i, steps.length - 1)];
  return {
    volumes,
    reads,
    io: {
      now: (() => {
        let t = 0;
        return () => (t += 150);
      })(),
      read: async () => {
        reads.count += 1;
        const [uri, positionSec, durationSec] = step();
        return { uri, positionSec, durationSec };
      },
      setVolume: async (v) => volumes.push(v),
      sleep: async () => {
        i += 1;
      },
    },
  };
}

test("a normal announce ramps up, holds, and restores without any transport call", async () => {
  const { io, volumes, reads } = fakeIo([
    [CLIP, 0],
    [CLIP, 1.5],
    [CLIP, 3],
    [CLIP, 12],
    [CLIP, 22.5],
    [CLIP, 24],
  ]);
  // Any transport method being present would be a design regression; assert the
  // driver never needs one by not providing any.
  const result = await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io);

  assert.equal(result.reason, "complete");
  assert.equal(result.sawClip, true);
  assert.deepEqual(volumes, [20, 8]);
  // One transport read per poll, not one per field. Stop once music is published.
  assert.equal(reads.count, 5);
});

test("only the endpoints ask Sonos to verify the level", async () => {
  const exact = [];
  const { io } = fakeIo([
    [CLIP, 1.5],
    [CLIP, 12],
    [CLIP, 22.5],
    [CLIP, 24],
  ]);
  io.setVolume = async (v) => exact.push(v);
  await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io);

  assert.deepEqual(exact, [20, 8]);
});

test("a skipped announce still puts the music volume back", async () => {
  const { io, volumes } = fakeIo([
    [CLIP, 0],
    [CLIP, 1.5],
    ["x-sonos-spotify:spotify:track:next", 0],
  ]);
  const result = await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io);

  assert.equal(result.reason, "left-playhead");
  assert.equal(volumes.at(-1), 8, "must end on the music volume");
});

test("live clip duration wins so restore is not scheduled 20s into the next song", async () => {
  const { io, volumes } = fakeIo([
    [CLIP, 0, 27.5],
    [CLIP, 3, 27.5],
    [CLIP, 26, 27.5],
    [CLIP, 27.5, 27.5],
  ]);
  const result = await runAnnounceVolume(
    {
      clipUrl: CLIP,
      durationSec: 49,
      rampSec: 3,
      restoreSec: 3,
      musicVolume: 8,
      announceVolume: 20,
    },
    io
  );

  assert.equal(result.reason, "complete");
  assert.deepEqual(volumes, [20, 8]);
});

test("resolveAnnounceClipDuration prefers the shorter trusted length", () => {
  assert.equal(resolveAnnounceClipDuration(49, 27.5), 27.5);
  assert.equal(
    resolveAnnounceClipDuration(27.5, 49),
    27.5,
    "inflated Sonos TrackDuration must not delay restore"
  );
  assert.equal(
    resolveAnnounceClipDuration(27.5, 3),
    27.5,
    "a tiny HTTP-stream stub must not dump volume during speech"
  );
  assert.equal(resolveAnnounceClipDuration(27.5, 0), 27.5);
  assert.equal(resolveAnnounceClipDuration(0, 27.5), 27.5);
});

test("a missing baseline is read when the clip actually starts, not before Play", async () => {
  const { io, volumes } = fakeIo([
    [CLIP, 0],
    [CLIP, 3],
    [CLIP, 24],
  ]);
  io.getVolume = async () => 8;
  const result = await runAnnounceVolume(
    {
      clipUrl: CLIP,
      durationSec: 24,
      rampSec: 3,
      restoreSec: 3,
      musicVolume: null,
      announceVolume: null,
      calculateTarget: () => 20,
    },
    io
  );

  assert.equal(result.reason, "complete");
  assert.equal(volumes[0], 20);
  assert.equal(volumes.at(-1), 8);
});

test("a clip that never reaches the playhead changes nothing", async () => {
  const { io, volumes } = fakeIo([["x-sonos-spotify:spotify:track:other", 10]]);
  const result = await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io, {
    graceMs: 300,
  });

  assert.equal(result.reason, "never-started");
  assert.equal(result.sawClip, false);
  assert.deepEqual(volumes, [], "must not touch volume for an announce that never played");
});

test("a speaker that drops the clip mid-announce does not leave the party boosted", async () => {
  const { io, volumes } = fakeIo([
    [CLIP, 0],
    [CLIP, 3],
    [CLIP, 10],
    ["x-sonos-spotify:spotify:track:next", 0],
  ]);
  await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io);

  assert.equal(volumes.at(-1), 8);
  assert.ok(volumes.includes(20), "should have boosted while the DJ was talking");
});

test("a failing setVolume during the announce does not crash the driver", async () => {
  const volumes = [];
  let i = 0;
  let boostAttempts = 0;
  const steps = [
    [CLIP, 0],
    [CLIP, 3],
    [CLIP, 12],
    [CLIP, 24],
  ];
  const io = {
    now: (() => {
      let t = 0;
      return () => (t += 150);
    })(),
    read: async () => {
      const [uri, positionSec] = steps[Math.min(i, steps.length - 1)];
      return { uri, positionSec };
    },
    setVolume: async (v) => {
      volumes.push(v);
      if (v === 20) {
        boostAttempts += 1;
        throw new Error("Sonos error on SetVolume");
      }
    },
    sleep: async () => {
      i += 1;
    },
  };

  const result = await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io);
  assert.equal(result.reason, "complete");
  assert.ok(boostAttempts >= 1, "must keep trying the announce level");
  assert.equal(volumes.at(-1), 8, "restore must run even when the boost threw");
});

test("the volume driver arms trim while it waits and locks while the clip plays", async () => {
  const { io } = fakeIo([
    [CLIP, 0],
    [CLIP, 3],
    [CLIP, 24],
  ]);
  let sawActive = false;
  const innerRead = io.read;
  io.read = async () => {
    if (isDjVolumeHandoffArmed() && isDjVolumeHandoffActive()) sawActive = true;
    return innerRead();
  };
  await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io);
  assert.equal(sawActive, true);
  assert.equal(isDjVolumeHandoffActive(), false);
  assert.equal(isDjVolumeHandoffArmed(), false);
});

test("a throwing transport read does not abort the volume loop", async () => {
  const volumes = [];
  let i = 0;
  const steps = [
    ["throw", 0],
    [CLIP, 0],
    [CLIP, 3],
    [CLIP, 24],
  ];
  const io = {
    now: (() => {
      let t = 0;
      return () => (t += 150);
    })(),
    read: async () => {
      const [uri, positionSec] = steps[Math.min(i, steps.length - 1)];
      if (uri === "throw") throw new Error("No reachable Sonos players for group volume.");
      return { uri, positionSec };
    },
    setVolume: async (v) => volumes.push(v),
    sleep: async () => {
      i += 1;
    },
  };

  const result = await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io);
  assert.equal(result.reason, "complete");
  assert.equal(result.sawClip, true);
  assert.ok(volumes.includes(20));
  assert.equal(volumes.at(-1), 8);
});

test("a stacked shout inherits the running music baseline, not a finished one", () => {
  assert.equal(
    inheritAnnounceMusicBaseline({ running: false, lastBaseline: 8 }),
    null
  );
  assert.equal(
    inheritAnnounceMusicBaseline({ running: true, lastBaseline: 8 }),
    8
  );
  assert.equal(
    inheritAnnounceMusicBaseline({ running: true, lastBaseline: null }),
    null
  );
});

test("a newer announce supersedes the previous volume session without restoring", async () => {
  const CLIP2 = "http://pq.local:8088/media/tts/dj-announce-def456.mp3";
  const volumesA = [];
  const volumesB = [];
  let aStep = 0;
  let bStep = 0;
  let releaseB;
  const bMayStart = new Promise((r) => {
    releaseB = r;
  });

  const ioA = {
    now: (() => {
      let t = 0;
      return () => (t += 50);
    })(),
    read: async () => {
      if (aStep === 1) releaseB();
      return { uri: CLIP, positionSec: Math.min(12, aStep * 3) };
    },
    setVolume: async (v) => volumesA.push(v),
    sleep: async () => {
      aStep += 1;
      await new Promise((r) => setTimeout(r, 15));
    },
  };

  const ioB = {
    now: (() => {
      let t = 0;
      return () => (t += 150);
    })(),
    read: async () => {
      const steps = [
        [CLIP2, 0],
        [CLIP2, 3],
        [CLIP2, 24],
      ];
      const [uri, positionSec] = steps[Math.min(bStep, steps.length - 1)];
      return { uri, positionSec };
    },
    setVolume: async (v) => volumesB.push(v),
    sleep: async () => {
      bStep += 1;
    },
  };

  const pA = runAnnounceVolume({ clipUrl: CLIP, ...shape }, ioA, {
    graceMs: 8000,
    maxMs: 8000,
  });
  await bMayStart;
  const aLenWhenBStarted = volumesA.length;
  const pB = runAnnounceVolume({ clipUrl: CLIP2, ...shape }, ioB);
  const [a, b] = await Promise.all([pA, pB]);

  assert.equal(a.reason, "superseded");
  assert.equal(b.reason, "complete");
  assert.equal(volumesB.at(-1), 8);
  assert.equal(lastAnnounceMusicBaseline(), 8);
  const aAfterB = volumesA.slice(aLenWhenBStarted);
  assert.ok(
    !aAfterB.includes(8),
    "the old session must not restore music volume after it lost the room"
  );
});

test("a struggling speaker is not polled faster while the clip is still waiting", async () => {
  const sleeps = [];
  let reads = 0;
  let t = 0;
  const io = {
    now: () => {
      t += 80;
      return t;
    },
    read: async () => {
      reads += 1;
      throw new Error("Sonos transport tick timed out");
    },
    setVolume: async () => {},
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  };
  const result = await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io, {
    graceMs: 50,
    waitMs: 1000,
    pollMs: 150,
    maxMs: 8_000,
  });

  assert.equal(result.reason, "timeout");
  assert.ok(sleeps[0] >= 1000, `first backoff should use waitMs, got ${sleeps[0]}`);
  assert.ok(
    sleeps[1] > sleeps[0],
    `consecutive failures should back off (${sleeps[0]} then ${sleeps[1]})`
  );
  assert.ok(reads < 12, `must not hammer the speaker, got ${reads} reads`);
});

test("transport ticks expose TrackDuration so restore can use the real clip length", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tickSrc = fs.readFileSync(
    path.join(here, "..", "src", "sonos-snapshots.js"),
    "utf8"
  );
  const voiceSrc = fs.readFileSync(
    path.join(here, "..", "src", "dj-voice.js"),
    "utf8"
  );
  assert.match(
    tickSrc,
    /durationSec:\s*parseSonosTime\(pos\.TrackDuration\)/
  );
  assert.match(voiceSrc, /durationSec:\s*Number\(tick\?\.durationSec\) \|\| 0/);
  const volumeSrc = fs.readFileSync(
    path.join(here, "..", "src", "dj-announce-volume.js"),
    "utf8"
  );
  assert.match(volumeSrc, /resolveAnnounceClipDuration\(/);
  assert.match(voiceSrc, /punchStartsAtSec:\s*punchStartsAtSecForBake\(baked\)/);
  assert.match(voiceSrc, /punchStartsAtSecForBake/);
  assert.match(voiceSrc, /ttsBytesPerSec\(provider\)/);
  assert.match(voiceSrc, /probeAudioDurationSec\(filePath/);
  assert.match(voiceSrc, /state:\s*tick\?\.state/);
  assert.match(voiceSrc, /observedAt:\s*Date\.now\(\)/);
});

test("scheduled ramps finish inside the silence, and a lead does not duck speech", () => {
  const speech = scheduleAnnounceVolume({ ...shape, positionSec: 3 });
  assert.equal(speech.phase, ANNOUNCE_PHASE.hold);
  assert.equal(speech.volume, 20);

  const marginEdge = scheduleAnnounceVolume({ ...shape, positionSec: 2.4 });
  assert.equal(marginEdge.volume, 20, "announce level is reached 0.6s before speech");

  const tailStart = scheduleAnnounceVolume({ ...shape, positionSec: 21 });
  assert.equal(tailStart.phase, ANNOUNCE_PHASE.restore);
  assert.equal(tailStart.volume, 8);

  const beforeEnd = scheduleAnnounceVolume({ ...shape, positionSec: 23.4 });
  assert.equal(beforeEnd.phase, ANNOUNCE_PHASE.restore);
  assert.equal(beforeEnd.volume, 8, "music level is the target for the whole closing silence");

  const leadDuringSpeech = scheduleAnnounceVolume({
    ...shape,
    positionSec: 20.9,
    leadSec: 0.5,
  });
  assert.equal(leadDuringSpeech.volume, 20);
  assert.equal(leadDuringSpeech.phase, ANNOUNCE_PHASE.hold);
});

test("PLAYING extrapolates a stuck RelTime, and pause does not", () => {
  const first = estimateAnnouncePlayhead(
    { positionSec: 0, state: "PLAYING", observedAt: 1_000 },
    1_000,
    { originAt: null }
  );
  const later = estimateAnnouncePlayhead(
    { positionSec: 0, state: "PLAYING", observedAt: 3_000 },
    3_000,
    { originAt: first.originAt }
  );
  assert.ok(
    later.positionSec >= 2 && later.positionSec <= 2.5,
    `expected playhead near 2s, got ${later.positionSec}`
  );
  const paused = estimateAnnouncePlayhead(
    { positionSec: 0, state: "PAUSED_PLAYBACK", observedAt: 9_000 },
    9_000,
    { originAt: first.originAt }
  );
  assert.equal(paused.positionSec, 0);
});

test("volume waits until the announcement is actually playing", async () => {
  const volumes = [];
  let i = 0;
  const steps = [
    { uri: CLIP, positionSec: 0, state: "PAUSED_PLAYBACK" },
    { uri: CLIP, positionSec: 0, state: "STOPPED" },
    { uri: CLIP, positionSec: 0, state: "PLAYING" },
    { uri: CLIP, positionSec: 3, state: "PLAYING" },
    { uri: CLIP, positionSec: 24, state: "PLAYING" },
  ];
  let t = 0;
  const io = {
    now: () => (t += 100),
    read: async () => steps[Math.min(i, steps.length - 1)],
    setVolume: async (v) => volumes.push(v),
    sleep: async () => {
      i += 1;
    },
  };
  const result = await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io, {
    graceMs: 20_000,
    logger: { debug() {}, warn() {}, error() {} },
  });
  assert.equal(result.reason, "complete");
  assert.equal(volumes[0], 20, "playback inside the opening silence publishes the announce level");
  assert.equal(volumes.at(-1), 8);
});

test("a late Play does not spend the opening silence on a timer", async () => {
  for (const leadSteps of [0, 2, 8]) {
    resetAnnounceVolumeForTests();
    const volumes = [];
    let i = 0;
    const steps = [
      ...Array.from({ length: leadSteps }, (_, n) => ({
        uri: "x-sonos-spotify:spotify:track:prev",
        positionSec: 40 + n,
        state: "PLAYING",
      })),
      { uri: CLIP, positionSec: 0, state: "PLAYING" },
      { uri: CLIP, positionSec: 1.2, state: "PLAYING" },
      { uri: CLIP, positionSec: 3, state: "PLAYING" },
      { uri: CLIP, positionSec: 24, state: "PLAYING" },
    ];
    let t = 0;
    const io = {
      now: () => (t += 200),
      read: async () => steps[Math.min(i, steps.length - 1)],
      setVolume: async (v) => volumes.push(v),
      sleep: async () => {
        i += 1;
      },
    };
    const result = await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io, {
      graceMs: 30_000,
      logger: { debug() {}, warn() {}, error() {} },
    });
    assert.equal(result.reason, "complete", `leadSteps=${leadSteps}`);
    assert.equal(
      volumes[0],
      20,
      `leadSteps=${leadSteps}: first write is the announce level`
    );
    assert.ok(volumes.includes(20), `leadSteps=${leadSteps}`);
    assert.equal(volumes.at(-1), 8, `leadSteps=${leadSteps}`);
  }
});

test("slow volume writes finish inside the silence windows", async () => {
  let clock = 0;
  const events = [];
  const warns = [];
  const io = {
    mono: () => clock,
    now: () => clock,
    read: async () => {
      const positionSec = Math.min(24, clock / 1000);
      return {
        uri: CLIP,
        positionSec,
        durationSec: 24,
        state: "PLAYING",
        observedAt: clock,
      };
    },
    setVolume: async (v) => {
      clock += 500;
      events.push({ v, at: clock / 1000 });
    },
    sleep: async (ms) => {
      clock += ms;
    },
  };
  const result = await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io, {
    pollMs: 150,
    logger: {
      debug() {},
      warn: (message) => warns.push(String(message)),
      error() {},
    },
  });
  assert.equal(result.reason, "complete");
  const full = events.find((event) => event.v === 20);
  assert.ok(full, "announce level was set");
  assert.ok(
    full.at < 3,
    `announce level landed at ${full.at}s; speech starts at 3s`
  );
  const duringSpeech = events.filter((event) => event.at >= 3 && event.at < 21);
  assert.ok(
    duringSpeech.every((event) => event.v === 20),
    `speech heard a partial ramp: ${JSON.stringify(duringSpeech.slice(0, 4))}`
  );
  const restored = events.find((event) => event.v === 8 && event.at >= 21);
  assert.ok(restored, "music level was set during the closing silence");
  assert.ok(
    restored.at < 24,
    `music level landed at ${restored.at}s; the clip ends at 24s`
  );
  assert.deepEqual(warns, []);
});

test("a stuck RelTime still reaches the announce level before speech", async () => {
  let clock = 0;
  const events = [];
  const io = {
    mono: () => clock,
    now: () => clock,
    read: async () => ({
      uri: CLIP,
      positionSec: 0,
      durationSec: 24,
      state: "PLAYING",
      observedAt: clock,
    }),
    setVolume: async (v) => {
      clock += 200;
      events.push({ v, at: clock / 1000 });
    },
    sleep: async (ms) => {
      clock += ms;
    },
  };
  await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io, {
    pollMs: 150,
    maxMs: 4_500,
    logger: { debug() {}, warn() {}, error() {} },
  });
  const full = events.find((event) => event.v === 20);
  assert.ok(full && full.at < 3, `announce level landed at ${full?.at}`);
  const partial = events.filter(
    (event) => event.at >= 3 && event.v > 8 && event.v < 20
  );
  assert.deepEqual(partial, []);
});

function stepPlayhead(state, at, origin, duration = 24) {
  return estimateAnnouncePlayhead(
    { positionSec: 0, state, observedAt: at, durationSec: duration },
    at,
    origin,
    duration
  );
}

test("a known duration lets a frozen RelTime cross the closing silence", () => {
  let origin = { originAt: null };
  origin = stepPlayhead("PLAYING", 0, origin);
  origin = stepPlayhead("PLAYING", 3_000, origin);
  assert.ok(origin.positionSec >= 3, `speech start, got ${origin.positionSec}`);
  origin = stepPlayhead("PLAYING", 21_000, origin);
  assert.ok(
    Math.abs(origin.positionSec - 21) < 0.05,
    `speech end, got ${origin.positionSec}`
  );
  const scheduled = scheduleAnnounceVolume({
    ...shape,
    positionSec: origin.positionSec,
  });
  assert.equal(scheduled.phase, ANNOUNCE_PHASE.restore);
  origin = stepPlayhead("PLAYING", 23_400, origin);
  assert.ok(origin.positionSec < 24, `music landing, got ${origin.positionSec}`);
  assert.ok(origin.positionSec >= 23.4 - 0.05);
  const landed = scheduleAnnounceVolume({
    ...shape,
    positionSec: origin.positionSec,
  });
  assert.equal(landed.volume, 8);
  origin = stepPlayhead("PLAYING", 40_000, origin);
  assert.equal(origin.positionSec, 24);
});

test("pause and stop freeze a synthetic playhead and resume does not catch up", () => {
  let origin = stepPlayhead("PLAYING", 0, { originAt: null });
  origin = stepPlayhead("PLAYING", 8_000, origin);
  assert.ok(Math.abs(origin.positionSec - 8) < 0.05, `before pause ${origin.positionSec}`);

  const paused = stepPlayhead("PAUSED_PLAYBACK", 9_000, origin);
  assert.ok(Math.abs(paused.positionSec - 8) < 0.05, `paused ${paused.positionSec}`);
  const pausedLater = stepPlayhead("PAUSED_PLAYBACK", 25_000, paused);
  assert.equal(pausedLater.positionSec, paused.positionSec);
  const scheduled = scheduleAnnounceVolume({
    ...shape,
    positionSec: pausedLater.positionSec,
  });
  assert.notEqual(scheduled.phase, ANNOUNCE_PHASE.restore);

  const resumed = stepPlayhead("PLAYING", 30_000, pausedLater);
  assert.ok(
    Math.abs(resumed.positionSec - paused.positionSec) < 0.05,
    `resume caught up to ${resumed.positionSec}`
  );
  const later = stepPlayhead("PLAYING", 31_000, resumed);
  assert.ok(
    Math.abs(later.positionSec - (paused.positionSec + 1)) < 0.05,
    `after resume ${later.positionSec}`
  );

  const stopped = stepPlayhead("STOPPED", 50_000, later);
  assert.equal(stopped.positionSec, later.positionSec);
  const stillStopped = stepPlayhead("STOPPED", 60_000, stopped);
  assert.equal(stillStopped.positionSec, later.positionSec);
});

test("an unknown duration keeps the 2.5s RelTime lead cap", () => {
  const first = estimateAnnouncePlayhead(
    { positionSec: 0, state: "PLAYING", observedAt: 0 },
    0,
    { originAt: null }
  );
  const later = estimateAnnouncePlayhead(
    { positionSec: 0, state: "PLAYING", observedAt: 5_000 },
    5_000,
    first
  );
  assert.ok(later.positionSec <= 2.5, `uncapped playhead ${later.positionSec}`);
  assert.ok(later.positionSec >= 2);
});

test("a frozen RelTime still restores during the closing silence", async () => {
  let clock = 0;
  let sawNext = false;
  const events = [];
  const NEXT = "x-sonos-spotify:spotify:track:next";
  const io = {
    mono: () => clock,
    now: () => clock,
    read: async () => {
      if (clock >= 24_000) {
        sawNext = true;
        return {
          uri: NEXT,
          positionSec: 0,
          state: "PLAYING",
          observedAt: clock,
        };
      }
      return {
        uri: CLIP,
        positionSec: 0,
        durationSec: 24,
        state: "PLAYING",
        observedAt: clock,
      };
    },
    setVolume: async (v) => {
      events.push({ v, at: clock / 1000, next: sawNext });
    },
    sleep: async (ms) => {
      clock += ms;
    },
  };
  const result = await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io, {
    pollMs: 150,
    maxMs: 30_000,
    logger: { debug() {}, warn() {}, error() {} },
  });
  assert.equal(result.reason, "complete");
  const boosted = events.find((event) => event.v === 20);
  assert.ok(boosted && boosted.at < 3, `announce level at ${boosted?.at}`);
  const restored = events.find((event) => event.v === 8 && event.at > 3);
  assert.ok(restored && restored.at >= 21 && restored.at < 24, `music level at ${restored?.at}`);
  assert.equal(restored.next, false);
  assert.equal(sawNext, false);
  assert.ok(events.every((event) => event.next === false));
});

test("pausing a frozen RelTime does not run the closing ramp or catch up", async () => {
  let clock = 0;
  let state = "PLAYING";
  const events = [];
  const io = {
    mono: () => clock,
    now: () => clock,
    read: async () => ({
      uri: CLIP,
      positionSec: 0,
      durationSec: 24,
      state,
      observedAt: clock,
    }),
    setVolume: async (v) => {
      events.push({ v, at: clock / 1000 });
    },
    sleep: async (ms) => {
      clock += ms;
      if (clock >= 8_000 && clock < 30_000) state = "PAUSED_PLAYBACK";
      else if (clock >= 30_000) state = "PLAYING";
    },
  };
  await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io, {
    pollMs: 150,
    maxMs: 40_000,
    logger: { debug() {}, warn() {}, error() {} },
  });
  const held = events.filter((event) => event.at >= 8 && event.at < 32);
  assert.ok(
    held.every((event) => event.v === 20),
    `volume moved while paused or on resume: ${JSON.stringify(held.slice(0, 8))}`
  );
});

test("the first sample already in speech warns once", async () => {
  let clock = 3_200;
  const warns = [];
  const io = {
    mono: () => clock,
    now: () => 0,
    read: async () => ({
      uri: CLIP,
      positionSec: Math.min(24, clock / 1000),
      durationSec: 24,
    }),
    setVolume: async () => {
      clock += 1_500;
    },
    sleep: async () => {
      clock += 150;
    },
  };
  await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io, {
    rampMarginSec: 0,
    restoreMarginSec: 0,
    applyLeadCapSec: 0,
    pollMs: 0,
    logger: {
      debug() {},
      warn: (message) => warns.push(String(message)),
      error() {},
    },
  });
  assert.equal(warns.length, 1, warns.join(" | "));
  assert.match(warns[0], /opening silence missed/);
});

test("skipping restores once and does not write again after the announce", async () => {
  const volumes = [];
  let i = 0;
  const steps = [
    [CLIP, 1.5],
    ["x-sonos-spotify:spotify:track:next", 0.2],
    ["x-sonos-spotify:spotify:track:next", 1],
  ];
  let t = 0;
  const io = {
    now: () => (t += 100),
    read: async () => {
      const [uri, positionSec] = steps[Math.min(i, steps.length - 1)];
      return { uri, positionSec };
    },
    setVolume: async (v) => volumes.push(v),
    sleep: async () => {
      i += 1;
    },
  };
  const result = await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io, {
    logger: { debug() {}, warn() {}, error() {} },
  });
  assert.equal(result.reason, "left-playhead");
  assert.equal(volumes.at(-1), 8);
  assert.equal(volumes.filter((v) => v === 8).length, 1);
  const n = volumes.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(volumes.length, n);
});

test("the next track is not what starts the restore", async () => {
  const volumes = [];
  let i = 0;
  const steps = [
    [CLIP, 0],
    [CLIP, 3],
    [CLIP, 21],
    [CLIP, 23.5],
    ["x-sonos-spotify:spotify:track:next", 0.2],
  ];
  let currentUri = null;
  let t = 0;
  const io = {
    now: () => (t += 100),
    read: async () => {
      const [uri, positionSec] = steps[Math.min(i, steps.length - 1)];
      currentUri = uri;
      return { uri, positionSec };
    },
    setVolume: async (v) => volumes.push({ v, uri: currentUri }),
    sleep: async () => {
      i += 1;
    },
  };
  const result = await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io, {
    logger: { debug() {}, warn() {}, error() {} },
  });
  assert.equal(result.reason, "complete");
  const boostAt = volumes.findIndex((event) => event.v === 20);
  assert.ok(boostAt >= 0);
  const restored = volumes.find((event, index) => index > boostAt && event.v === 8);
  assert.ok(restored, "music level was written");
  assert.equal(restored.uri, CLIP);
  assert.ok(!volumes.some((event) => event.uri !== CLIP));
});


test("a superseded announce sends the new target only after the in-flight write settles", async () => {
  const CLIP2 = "http://pq.local:8088/media/tts/dj-announce-def456.mp3";
  const sent = [];
  let releaseFirst;
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  const office = {
    Name: "Office",
    Host: "10.10.20.50",
    setVolume: (level) => {
      calls += 1;
      sent.push(level);
      if (calls === 1) return gate;
      return Promise.resolve();
    },
  };
  let clock = 0;
  let releaseOnSleep = false;
  const ioA = {
    now: () => clock,
    speakers: [office],
    read: async () => ({
      uri: CLIP,
      positionSec: 0,
      state: "PLAYING",
      observedAt: clock,
    }),
    sleep: async (ms) => {
      clock += ms;
    },
  };
  const pendingA = runAnnounceVolume({ clipUrl: CLIP, ...shape }, ioA, {
    graceMs: 8_000,
    maxMs: 8_000,
    logger: { debug() {}, warn() {}, error() {} },
  });
  await Promise.resolve();
  const ioB = {
    now: () => clock,
    speakers: [office],
    read: async () => {
      const positionSec = Math.min(24, clock / 1000);
      return {
        uri: CLIP2,
        positionSec,
        durationSec: 24,
        state: "PLAYING",
        observedAt: clock,
      };
    },
    sleep: async (ms) => {
      clock += ms;
      if (releaseOnSleep) {
        releaseOnSleep = false;
        releaseFirst();
      }
    },
  };
  releaseOnSleep = true;
  const resultB = await runAnnounceVolume({ clipUrl: CLIP2, ...shape }, ioB, {
    pollMs: 150,
    maxMs: 30_000,
    logger: { debug() {}, warn() {}, error() {} },
  });
  const resultA = await pendingA;
  assert.equal(resultA.reason, "superseded");
  assert.equal(resultB.reason, "complete");
  assert.equal(sent[0], 20);
  assert.equal(sent.at(-1), 8);
  assert.equal(sent.filter((level) => level !== 20 && level !== 8).length, 0);
  const n = sent.length;
  clock += 10_000;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sent.length, n);
});

test("Kitchen reaches both endpoints while Office is still pending", async () => {
  let clock = 0;
  const kitchen = [];
  let officeCalls = 0;
  let releaseOffice;
  const officeGate = new Promise((resolve) => {
    releaseOffice = resolve;
  });
  const reads = [];
  const io = {
    now: () => clock,
    mono: () => clock,
    speakers: [
      {
        Name: "Kitchen",
        Host: "10.10.20.10",
        setVolume: async (level) => {
          kitchen.push({ level, at: clock });
          clock += 50;
        },
      },
      {
        Name: "Office",
        Host: "10.10.20.50",
        setVolume: () => {
          officeCalls += 1;
          return officeGate;
        },
      },
    ],
    read: async () => {
      reads.push(clock);
      return {
        uri: CLIP,
        positionSec: Math.min(24, clock / 1000),
        durationSec: 24,
        state: "PLAYING",
        observedAt: clock,
      };
    },
    sleep: async (ms) => {
      clock += ms;
    },
  };
  await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io, {
    pollMs: 150,
    logger: { debug() {}, warn() {}, error() {} },
  });
  const opening = kitchen.find((event) => event.level === 20);
  assert.ok(opening && opening.at < 3_000, JSON.stringify(opening));
  const music = kitchen.find((event) => event.level === 8);
  assert.ok(
    music && music.at >= 21_000 && music.at < 24_000,
    JSON.stringify(music)
  );
  assert.equal(officeCalls, 1);
  assert.ok(reads.length > 3, "playhead kept moving while Office was pending");
  const kitchenCount = kitchen.length;
  const officeCount = officeCalls;
  releaseOffice();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(kitchen.length, kitchenCount);
  assert.equal(officeCalls, officeCount);
});

test("a speaker that wedges mid-announcement drops out and the rest finish", async () => {
  let clock = 0;
  const kitchen = [];
  const livingRoom = [];
  const officeSent = [];
  // Must stay at zero: the re-filter reads the in-memory skip map only.
  const topologyCalls = { resolveGroup: 0, getZoneGroups: 0, zoneGroupState: 0 };

  const healthy = (name, host, log) => ({
    Name: name,
    Host: host,
    setVolume: async (level) => {
      log.push({ level, at: clock });
      clock += 10;
    },
    GetZoneGroupState: async () => {
      topologyCalls.zoneGroupState += 1;
      return [];
    },
  });

  const io = {
    now: () => clock,
    mono: () => clock,
    speakers: [
      healthy("Kitchen", "10.10.20.10", kitchen),
      healthy("Living Room", "10.10.20.11", livingRoom),
      {
        Name: "Office",
        Host: "10.10.20.96",
        // Wedged: still in topology, answers nothing. Every write times out.
        setVolume: async (level) => {
          officeSent.push({ level, at: clock });
          clock += 10;
          throw new Error("Sonos volume write timed out");
        },
        GetZoneGroupState: async () => {
          topologyCalls.zoneGroupState += 1;
          return [];
        },
      },
    ],
    resolveGroup: async () => {
      topologyCalls.resolveGroup += 1;
      return { members: [] };
    },
    getZoneGroups: async () => {
      topologyCalls.getZoneGroups += 1;
      return [];
    },
    read: async () => ({
      uri: CLIP,
      positionSec: Math.min(24, clock / 1000),
      durationSec: 24,
      state: "PLAYING",
      observedAt: clock,
    }),
    sleep: async (ms) => {
      clock += ms;
    },
  };

  await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io, {
    pollMs: 150,
    logger: { debug() {}, warn() {}, error() {} },
  });

  const office = io.speakers[2];
  assert.equal(isPlayerSkipped(office), true);

  // Office saw the announce level only, and never the restore level: once the
  // first write timed out, the next publish filtered it out.
  assert.deepEqual([...new Set(officeSent.map((e) => e.level))], [20]);
  assert.equal(
    officeSent.some((e) => e.level === 8),
    false
  );

  // The other two got the whole sequence and restored to music level.
  for (const log of [kitchen, livingRoom]) {
    assert.ok(
      log.some((e) => e.level === 20),
      "announce level"
    );
    assert.equal(log.at(-1).level, 8, "restored to music level");
  }

  assert.deepEqual(topologyCalls, {
    resolveGroup: 0,
    getZoneGroups: 0,
    zoneGroupState: 0,
  });
});

test("Play imminent switches the wait poll to 150ms so opening silence is not missed", async () => {
  const sleeps = [];
  let step = 0;
  const io = {
    read: async () => {
      if (step === 0) return { uri: "x-rincon-queue:RINCON", positionSec: 12 };
      if (step === 1) {
        markAnnouncePlaybackImminent();
        return { uri: "x-rincon-queue:RINCON", positionSec: 12.2 };
      }
      return {
        uri: CLIP,
        positionSec: Math.min(24, 0.2 + Math.max(0, step - 2) * 4),
        durationSec: 24,
        state: "PLAYING",
        queueTrack: 1,
      };
    },
    setVolume: async () => {},
    sleep: async (ms) => {
      sleeps.push(ms);
      step += 1;
    },
  };
  const result = await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io, {
    waitMs: 1000,
    pollMs: 150,
    maxMs: 4000,
    logger: { debug() {}, warn() {}, error() {} },
  });
  assert.equal(result.sawClip, true);
  assert.ok(sleeps[0] >= 1000, `armed wait should stay slow, got ${sleeps[0]}`);
  assert.equal(sleeps[1], 150, `Play should poll at 150ms, got ${sleeps[1]}`);
});

function logField(line, name) {
  const match = String(line).match(new RegExp(`(?:^|\\s)${name}=(\\S+)`));
  assert.ok(match, `${name} missing in ${line}`);
  return match[1];
}

test("closing publish with direct RelTime logs the sample that triggered it", async () => {
  let clock = 0;
  const calls = {
    read: 0,
    setVolume: 0,
    GetPositionInfo: 0,
    GetTransportInfo: 0,
    GetVolume: 0,
    SetVolume: 0,
  };
  const levels = [];
  const logs = [];
  const office = {
    Name: "Office",
    Host: "10.10.20.50",
    setVolume: async (level) => {
      calls.setVolume += 1;
      levels.push({ level, at: clock });
    },
    RenderingControlService: {
      SetVolume: async () => {
        calls.SetVolume += 1;
      },
      GetVolume: async () => {
        calls.GetVolume += 1;
        return { CurrentVolume: 8 };
      },
    },
    AVTransportService: {
      GetPositionInfo: async () => {
        calls.GetPositionInfo += 1;
      },
      GetTransportInfo: async () => {
        calls.GetTransportInfo += 1;
      },
    },
  };
  const io = {
    mono: () => clock,
    now: () => clock,
    read: async () => {
      calls.read += 1;
      return {
        uri: CLIP,
        positionSec: clock / 1000,
        durationSec: 24,
        state: "PLAYING",
        queueTrack: 1,
        observedAt: clock,
      };
    },
    speakers: [office],
    sleep: async (ms) => {
      clock += ms;
    },
  };
  await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io, {
    pollMs: 150,
    maxMs: 30_000,
    logger: {
      debug() {},
      warn() {},
      error() {},
      info: (line) => logs.push(String(line)),
    },
  });
  const closing = logs.filter((line) => line.includes("[dj-volume] closing-publish"));
  assert.equal(closing.length, 1);
  const line = closing[0];
  assert.equal(logField(line, "uri"), CLIP);
  assert.equal(logField(line, "state"), "PLAYING");
  assert.equal(logField(line, "track"), "1");
  assert.equal(logField(line, "rel"), "21.0");
  assert.equal(logField(line, "estimated"), "21.0");
  assert.equal(logField(line, "duration"), "24.0");
  assert.equal(logField(line, "trackDuration"), "24.0");
  assert.equal(logField(line, "threshold"), "21.0");
  assert.equal(logField(line, "source"), "rel-time");
  assert.equal(logField(line, "at"), "21000");
  assert.deepEqual(levels.map((row) => row.level), [20, 8]);
  assert.equal(levels[1].at, 21000);
  assert.ok(calls.read > 0);
  assert.equal(calls.setVolume, 2);
  assert.equal(calls.GetPositionInfo, 0);
  assert.equal(calls.GetTransportInfo, 0);
  assert.equal(calls.GetVolume, 0);
  assert.equal(calls.SetVolume, 0);
});

test("closing publish driven by wall-clock extrapolation names that source", async () => {
  let clock = 0;
  const pending = [];
  const logs = [];
  const office = {
    Name: "Office",
    Host: "10.10.20.50",
    setVolume: (level) => {
      const gate = deferredGate();
      pending.push({ level, gate });
      return gate.promise;
    },
  };
  const io = {
    mono: () => clock,
    now: () => clock,
    read: async () => ({
      uri: CLIP,
      positionSec: 0,
      durationSec: 24,
      state: "PLAYING",
      queueTrack: 1,
      observedAt: clock,
    }),
    speakers: [office],
    sleep: async (ms) => {
      clock += ms;
    },
  };
  await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io, {
    pollMs: 150,
    maxMs: 30_000,
    logger: {
      debug() {},
      warn() {},
      error() {},
      info: (line) => logs.push(String(line)),
    },
  });
  const line = logs.find((entry) => entry.includes("[dj-volume] closing-publish"));
  assert.ok(line);
  assert.equal(logField(line, "rel"), "0.0");
  assert.equal(logField(line, "estimated"), "21.0");
  assert.equal(logField(line, "duration"), "24.0");
  assert.equal(logField(line, "threshold"), "21.0");
  assert.equal(logField(line, "source"), "wall-clock");
  assert.equal(logField(line, "writingBefore"), "1");
  assert.equal(logField(line, "writingAfter"), "1");
  assert.equal(logField(line, "activeBefore"), "Office@20/20");
  assert.equal(logField(line, "activeAfter"), "Office@20/8");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].level, 20);
  pending[0].gate.resolve();
});

function deferredGate() {
  /** @type {(value?: unknown) => void} */
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("a resumed frozen playhead is labeled rebased", () => {
  let origin = estimateAnnouncePlayhead(
    { positionSec: 0, state: "PLAYING", observedAt: 0 },
    0,
    { originAt: null },
    24
  );
  origin = estimateAnnouncePlayhead(
    { positionSec: 0, state: "PLAYING", observedAt: 8_000 },
    8_000,
    origin,
    24
  );
  assert.equal(origin.source, "wall-clock");
  const paused = estimateAnnouncePlayhead(
    { positionSec: 0, state: "PAUSED_PLAYBACK", observedAt: 9_000 },
    9_000,
    origin,
    24
  );
  assert.equal(paused.source, "rebased");
  const resumed = estimateAnnouncePlayhead(
    { positionSec: 0, state: "PLAYING", observedAt: 30_000 },
    30_000,
    paused,
    24
  );
  assert.equal(resumed.source, "rebased");
  assert.ok(Math.abs(resumed.positionSec - 8) < 0.05);
});

const WATCH_AT = Date.parse("2026-10-02T16:02:52.503Z");
const SPOTIFY = "x-sonos-spotify:spotify%3atrack%3a1raAR3au3OUh2f2F00Plil";

function clipSample(rel, state, dur = 22, track = 1) {
  return {
    uri: CLIP,
    state,
    positionSec: rel,
    durationSec: dur,
    queueTrack: track,
  };
}

function postDriverHarness(samples, { maxMs = 1_500, pollMs = 500, stillCurrent } = {}) {
  const lines = [];
  const commands = [];
  let clock = WATCH_AT;
  let index = 0;
  const transport = {
    play: async () => commands.push("play"),
    pause: async () => commands.push("pause"),
    next: async () => commands.push("next"),
    previous: async () => commands.push("previous"),
    seek: async () => commands.push("seek"),
    stop: async () => commands.push("stop"),
    switchToQueue: async () => commands.push("switch"),
  };
  return {
    lines,
    commands,
    transport,
    reads: () => index,
    run(extra = {}) {
      return observePostDriverTransport({
        clipUrl: CLIP,
        epoch: 7,
        driverReturnedAt: WATCH_AT,
        musicLevel: 8,
        maxMs,
        pollMs,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        stillCurrent: stillCurrent || (() => true),
        read: async () => samples[Math.min(index++, samples.length - 1)],
        logger: { info: (line) => lines.push(String(line)) },
        ...transport,
        ...extra,
      });
    },
  };
}

test("watcher keeps reading after the volume driver returns complete", async () => {
  const volumes = [];
  let i = 0;
  const steps = [
    clipSample(0, "PLAYING", 24),
    clipSample(3, "PLAYING", 24),
    clipSample(22, "PLAYING", 24),
  ];
  let t = 0;
  const io = {
    now: () => (t += 100),
    read: async () => steps[Math.min(i, steps.length - 1)],
    setVolume: async (v) => volumes.push(v),
    sleep: async () => {
      i += 1;
    },
  };
  const result = await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io, {
    graceMs: 20_000,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  assert.equal(result.reason, "complete");
  assert.equal(typeof result.generation, "number");
  assert.equal(volumes.at(-1), 8);
  const lines = [];
  let clock = WATCH_AT;
  let reads = 0;
  const watched = await observePostDriverTransport({
    clipUrl: CLIP,
    epoch: result.generation,
    driverReturnedAt: WATCH_AT,
    musicLevel: 8,
    maxMs: 30_000,
    pollMs: 500,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      if (reads >= 2) clock += 30_000;
    },
    stillCurrent: () => true,
    read: async () => {
      reads += 1;
      return clipSample(21, "PLAYING", 24);
    },
    logger: { info: (line) => lines.push(String(line)) },
  });
  assert.ok(reads >= 2);
  assert.equal(watched.reason, "timeout");
  assert.match(lines.join("\n"), /post-driver sample/);
  assert.match(lines.join("\n"), /firstState=PLAYING/);
});

test("same DJ URI staying PLAYING is logged and issues no command", async () => {
  const harness = postDriverHarness([
    clipSample(19, "PLAYING"),
    clipSample(20, "PLAYING"),
    clipSample(21, "PLAYING"),
  ]);
  const watched = await harness.run();
  assert.equal(watched.reason, "timeout");
  assert.ok(harness.lines.some((line) => /state=PLAYING/.test(line)));
  assert.equal(
    harness.lines.some((line) => line.includes("post-driver transition")),
    false
  );
  assert.deepEqual(harness.commands, []);
});

test("PLAYING to STOPPED at the start of the same DJ URI is a distinct transition", async () => {
  const harness = postDriverHarness(
    [clipSample(19, "PLAYING"), clipSample(0, "STOPPED")],
    { maxMs: 1_200 }
  );
  const watched = await harness.run();
  assert.equal(watched.reason, "timeout");
  const transition = harness.lines.find((line) =>
    line.includes("post-driver transition")
  );
  assert.match(transition, /PLAYING -> STOPPED/);
  assert.match(transition, /signature=stopped-at-start/);
  assert.match(transition, /sameClip=1/);
  assert.match(transition, /relReset=1/);
  assert.deepEqual(harness.commands, []);
});

test("a URI change to Spotify is recorded and the watcher stops", async () => {
  const harness = postDriverHarness(
    [
      clipSample(21, "PLAYING"),
      {
        uri: SPOTIFY,
        state: "PLAYING",
        positionSec: 1,
        durationSec: 188,
        queueTrack: 2,
      },
    ],
    { maxMs: 30_000 }
  );
  const watched = await harness.run();
  assert.equal(watched.reason, "uri-changed");
  assert.equal(harness.reads(), 2);
  const joined = harness.lines.join("\n");
  assert.match(joined, /uriChanged=1/);
  assert.match(joined, new RegExp(SPOTIFY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(joined, /reason=uri-changed/);
  assert.match(joined, /uriChangeAt=/);
  assert.deepEqual(harness.commands, []);
});

test("the watcher stops at 30 seconds without recovery", async () => {
  const harness = postDriverHarness(
    [clipSample(19, "PLAYING")],
    { maxMs: 30_000, pollMs: 10_000 }
  );
  const watched = await harness.run();
  assert.equal(watched.reason, "timeout");
  assert.equal(harness.reads(), 3);
  assert.deepEqual(harness.commands, []);
  assert.match(harness.lines.at(-1), /reason=timeout/);
});

test("a superseded announcement stops the old watcher", async () => {
  let current = true;
  const harness = postDriverHarness(
    [clipSample(19, "PLAYING")],
    {
      maxMs: 30_000,
      stillCurrent: () => current,
    }
  );
  const watched = await harness.run({
    read: async () => {
      current = false;
      return clipSample(19, "PLAYING");
    },
  });
  assert.equal(watched.reason, "superseded");
  assert.equal(
    harness.lines.some((line) => line.includes("post-driver sample")),
    false
  );
  assert.match(harness.lines.at(-1), /reason=superseded/);
  assert.deepEqual(harness.commands, []);
});

test("post-driver diagnostics add no transport command", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const volumeSrc = fs.readFileSync(
    path.join(here, "..", "src", "dj-announce-volume.js"),
    "utf8"
  );
  const voiceSrc = fs.readFileSync(
    path.join(here, "..", "src", "dj-voice.js"),
    "utf8"
  );
  const start = volumeSrc.indexOf("export async function observePostDriverTransport");
  const end = volumeSrc.indexOf("export function uriMatchesClip");
  const watcher = volumeSrc.slice(start, end);
  assert.ok(start >= 0 && end > start);
  for (const word of [
    ".Play",
    ".Pause",
    ".Next",
    ".Previous",
    ".Seek",
    ".Stop",
    "SwitchToQueue",
    "play(",
    "pause(",
    "next(",
    "seek(",
  ]) {
    assert.equal(watcher.includes(word), false, word);
  }
  assert.match(voiceSrc, /announce volume finished \(\$\{result\.reason\}\)/);
  assert.match(voiceSrc, /if \(!result\?\.sawClip\) return/);
  assert.match(voiceSrc, /observePostDriverTransport\(/);
  assert.match(voiceSrc, /waitForCoordinatorTransport\(/);
  const post = voiceSrc.slice(voiceSrc.indexOf("observePostDriverTransport("));
  const postBlock = post.slice(0, post.indexOf(".catch("));
  assert.equal(
    postBlock.includes("getTransportTick"),
    false,
    "post-driver log must not start its own transport SOAP"
  );
});

test("the post-driver summary records the music-level timeout and its retry", async () => {
  const { publishSpeakerVolume } = await import("../src/dj-speaker-volume.js");
  const { resetSpeakerHealthForTests } = await import("../src/sonos-speaker-health.js");
  const sent = [];
  let calls = 0;
  const office = {
    Name: "Office",
    Host: "10.10.20.77",
    setVolume: async (level) => {
      calls += 1;
      sent.push(level);
      if (calls === 1) throw new Error("Sonos volume write timed out");
    },
  };
  try {
    publishSpeakerVolume(office, 8, 9);
    for (let n = 0; n < 8; n += 1) await Promise.resolve();
    const harness = postDriverHarness([clipSample(19, "PLAYING")], {
      maxMs: 30_000,
    });
    const watched = await harness.run({ epoch: 9, musicLevel: 8, maxMs: 0 });
    assert.deepEqual(sent, [8, 8]);
    assert.equal(watched.reason, "timeout");
    assert.equal(watched.music.timedOut, true);
    assert.equal(typeof watched.music.retryFinishedAt, "number");
    const summary = harness.lines.at(-1);
    assert.match(summary, /musicTimeout=1/);
    assert.match(summary, /musicTimeoutAt=2026-/);
    assert.match(summary, /musicRetryAt=2026-/);
    assert.match(summary, /musicRetryFinish=2026-/);
    assert.match(summary, /driverReturnedAt=2026-10-02T16:02:52.503Z/);
    assert.deepEqual(harness.commands, []);
    assert.equal(harness.reads(), 0);
  } finally {
    resetSpeakerHealthForTests();
  }
});
