import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  announceVolumePayload,
  resetAnnounceVolumeForTests,
  runAnnounceVolume,
} from "../src/dj-announce-volume.js";
import {
  assertManualVolumeAvailable,
  configureVolumeIo,
  getCachedGroupVolume,
  noteGroupVolume,
  resetVolumeReachabilityForTests,
  volumeUp,
} from "../src/sonos-volume.js";
import {
  isDjVolumeHandoffActive,
  setDjVolumeHandoffActive,
  setDjVolumeHandoffArmed,
} from "../src/dj-volume-handoff-state.js";
import { volumePollMs } from "../public/js/mix-labels.js";

const CLIP = "http://pq.local:8088/media/tts/dj-announce-abc123.mp3";
const shape = {
  durationSec: 24,
  rampSec: 3,
  restoreSec: 3,
  musicVolume: 8,
  announceVolume: 22,
};

afterEach(() => {
  resetAnnounceVolumeForTests();
  resetVolumeReachabilityForTests();
  setDjVolumeHandoffActive(false);
  setDjVolumeHandoffArmed(false);
  configureVolumeIo({});
});

test("publishing announce and music updates the volume payload before SetVolume settles", async () => {
  noteGroupVolume(8);
  assert.deepEqual(announceVolumePayload(), {
    ok: true,
    volume: 8,
    ramping: false,
  });

  let clock = 0;
  let volumeReads = 0;
  let officeCalls = 0;
  let releaseOffice;
  const officeGate = new Promise((resolve) => {
    releaseOffice = resolve;
  });
  const kitchen = [];
  let announceLocked = false;
  const countRead = async () => {
    volumeReads += 1;
    return 8;
  };
  const io = {
    now: () => clock,
    mono: () => clock,
    getVolume: countRead,
    speakers: [
      {
        Name: "Kitchen",
        Host: "10.10.20.10",
        getVolume: countRead,
        setVolume: async (level) => {
          kitchen.push({
            level,
            at: clock,
            payload: announceVolumePayload(),
            officeCalls,
          });
          clock += 50;
        },
      },
      {
        Name: "Office",
        Host: "10.10.20.50",
        getVolume: countRead,
        setVolume: (level) => {
          officeCalls += 1;
          if (level === 22) {
            try {
              assertManualVolumeAvailable();
            } catch (err) {
              announceLocked = err?.statusCode === 423;
            }
          }
          return officeGate;
        },
      },
    ],
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

  const opening = kitchen.find((event) => event.level === 22);
  assert.ok(opening, "Kitchen was given the announce level");
  assert.ok(opening.at < 3_000, JSON.stringify(opening));
  assert.deepEqual(opening.payload, {
    ok: true,
    volume: 22,
    ramping: true,
    phase: "ramping-up",
  });
  assert.equal(opening.officeCalls, 0);

  const music = kitchen.find((event) => event.level === 8);
  assert.ok(music, "Kitchen was given the music level");
  assert.ok(music.at >= 21_000 && music.at < 24_000, JSON.stringify(music));
  assert.deepEqual(music.payload, {
    ok: true,
    volume: 8,
    ramping: true,
    phase: "ramping-down",
  });
  assert.equal(
    music.officeCalls,
    1,
    "music display must not wait for Office's announce write to finish"
  );
  assert.equal(volumeReads, 0);
  assert.equal(announceLocked, true);

  assert.equal(isDjVolumeHandoffActive(), false);
  assert.doesNotThrow(() => assertManualVolumeAvailable());
  assert.equal(getCachedGroupVolume(), 8);
  assert.deepEqual(announceVolumePayload(), {
    ok: true,
    volume: 8,
    ramping: false,
  });

  releaseOffice();
  await new Promise((resolve) => setTimeout(resolve, 30));
});

test("manual volume outside a handoff still steps from the cached level", async () => {
  noteGroupVolume(8);
  let current = 99;
  let reads = 0;
  const kitchen = {
    Host: "10.10.20.10",
    get volume() {
      return current;
    },
    get reads() {
      return reads;
    },
    RenderingControlService: {
      async GetVolume() {
        reads += 1;
        return { CurrentVolume: String(current) };
      },
      async SetVolume({ DesiredVolume }) {
        current = Number(DesiredVolume);
      },
    },
  };
  configureVolumeIo({
    resolveMembers: async () => [kitchen],
  });

  assert.deepEqual(announceVolumePayload(), {
    ok: true,
    volume: 8,
    ramping: false,
  });
  const stepped = await volumeUp(1);
  assert.equal(stepped.volume, 9);
  assert.equal(kitchen.volume, 9);
  assert.equal(getCachedGroupVolume(), 9);
  assert.deepEqual(announceVolumePayload(), {
    ok: true,
    volume: 9,
    ramping: false,
  });
  assert.ok(kitchen.reads >= 1, "the existing lock still verifies after the write");
});

test("the volume watch stays fast for the whole announce clip", () => {
  assert.equal(volumePollMs(false), 0);
  assert.equal(volumePollMs(true), 250);
  assert.equal(volumePollMs(false, true), 250);
});
