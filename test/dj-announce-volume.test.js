import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  announceVolumeAt,
  inheritAnnounceMusicBaseline,
  lastAnnounceMusicBaseline,
  resetAnnounceVolumeForTests,
  runAnnounceVolume,
  uriMatchesClip,
  ANNOUNCE_PHASE,
} from "../src/dj-announce-volume.js";
import {
  isDjVolumeHandoffActive,
  isDjVolumeHandoffArmed,
  setDjVolumeHandoffActive,
  setDjVolumeHandoffArmed,
} from "../src/dj-volume-handoff-state.js";

afterEach(() => {
  setDjVolumeHandoffArmed(false);
  setDjVolumeHandoffActive(false);
  resetAnnounceVolumeForTests();
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

test("volume ramps up across the silent lead pad", () => {
  assert.deepEqual(at(0), { phase: ANNOUNCE_PHASE.ramp, volume: 8, progress: 0 });
  assert.equal(at(1.5).volume, 14);
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

test("volume ramps back down across the trailing pad and ends on the music level", () => {
  assert.equal(at(21).phase, ANNOUNCE_PHASE.restore);
  assert.equal(at(21).volume, 20);
  assert.equal(at(22.5).volume, 14);
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
  assert.deepEqual(volumes, [8, 14, 20, 14, 8, 8]);
  // One transport read per poll, not one per field.
  assert.equal(reads.count, 6);
});

test("only the endpoints ask Sonos to verify the level", async () => {
  const exact = [];
  const { io } = fakeIo([
    [CLIP, 1.5],
    [CLIP, 12],
    [CLIP, 24],
  ]);
  io.setVolume = async (v, isExact) => exact.push([v, !!isExact]);
  await runAnnounceVolume({ clipUrl: CLIP, ...shape }, io);

  assert.deepEqual(exact, [
    [14, false], // mid-ramp: transient, no read-back
    [20, true], // the DJ speaks at this level, so it must land
    [8, true], // back to the music level, so it must land
    [8, true], // final restore even if a mid-announce write threw
  ]);
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
  assert.deepEqual(volumes, [8, 20, 14, 8, 8]);
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
  assert.equal(volumes[0], 8);
  assert.ok(volumes.includes(20));
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
});
