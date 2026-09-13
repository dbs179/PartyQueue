import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  bakeAnnounceClip,
  bakedAnnounceName,
  isBakedAnnounceUri,
  BAKED_PREFIX,
} from "../src/dj-announce-bake.js";
import {
  isAnnounceQueuePad,
  isDjVoiceUri,
  isDjSilenceUri,
} from "../src/sonos-queue-policy.js";

function makeDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pq-bake-"));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

const PADS = {
  "silence-ramp-3s.mp3": "RAMP",
  "silence-3s.mp3": "RESTORE",
  "lead.mp3": "LEAD",
  "punch.mp3": "PUNCH",
};

const base = (dir) => ({
  ttsDir: dir,
  leadFile: "lead.mp3",
  rampFile: "silence-ramp-3s.mp3",
  restoreFile: "silence-3s.mp3",
  rampSec: 3,
  restoreSec: 3,
  leadSec: 12,
  publicBaseUrl: "http://pq.local:8088",
});

test("the baked name is stable for the same parts and differs when any part changes", () => {
  const a = bakedAnnounceName({ leadFile: "x.mp3", rampSec: 3, restoreSec: 3 });
  const b = bakedAnnounceName({ leadFile: "x.mp3", rampSec: 3, restoreSec: 3 });
  assert.equal(a, b);

  assert.notEqual(
    a,
    bakedAnnounceName({ leadFile: "y.mp3", rampSec: 3, restoreSec: 3 })
  );
  assert.notEqual(
    a,
    bakedAnnounceName({ leadFile: "x.mp3", rampSec: 4, restoreSec: 3 })
  );
  // Banter must not collide with the same lead played solo.
  assert.notEqual(
    a,
    bakedAnnounceName({
      leadFile: "x.mp3",
      punchFile: "p.mp3",
      rampSec: 3,
      restoreSec: 3,
    })
  );
});

test("a baked announce is recognisable from its URI alone", () => {
  const name = bakedAnnounceName({ leadFile: "x.mp3", rampSec: 3, restoreSec: 3 });
  assert.ok(isBakedAnnounceUri(`http://pq.local:8088/media/tts/${name}`));
  assert.ok(!isBakedAnnounceUri("http://pq.local:8088/media/tts/silence-3s.mp3"));
  assert.ok(!isBakedAnnounceUri("x-sonos-spotify:spotify:track:abc"));
  assert.ok(!isBakedAnnounceUri(""));
});

test("a baked announce classifies as a DJ row, not as a song or a silence pad", () => {
  const url = `http://pq.local:8088/media/tts/${bakedAnnounceName({
    leadFile: "x.mp3",
    rampSec: 3,
    restoreSec: 3,
  })}`;

  assert.ok(isAnnounceQueuePad(url), "must be treated as an announce row");
  assert.ok(isDjVoiceUri(url), "must count as DJ voice");
  assert.ok(!isDjSilenceUri(url), "must not be mistaken for a bare silence pad");
  assert.ok(!isAnnounceQueuePad("x-sonos-spotify:spotify:track:abc"));
  // Filename marker, not the /media/tts path — a moved host still counts.
  assert.ok(isDjVoiceUri(`http://other.local/clips/${url.split("/").pop()}`));
});

test("baking concatenates ramp, lead and restore in play order", async () => {
  const dir = makeDir(PADS);
  let seen = null;
  const result = await bakeAnnounceClip({
    ...base(dir),
    concat: async (inputs, out) => {
      seen = inputs.map((p) => path.basename(p));
      fs.writeFileSync(out, "BAKED");
    },
  });

  assert.deepEqual(seen, ["silence-ramp-3s.mp3", "lead.mp3", "silence-3s.mp3"]);
  assert.equal(result.durationSec, 18);
  assert.equal(result.speechSec, 12);
  assert.equal(result.cached, false);
  assert.ok(result.publicUrl.endsWith(result.fileName));
  assert.ok(result.fileName.startsWith(BAKED_PREFIX));
  assert.equal(fs.readFileSync(result.filePath, "utf8"), "BAKED");
});

test("banter puts the punch clip between the lead and the restore pad", async () => {
  const dir = makeDir(PADS);
  let seen = null;
  const result = await bakeAnnounceClip({
    ...base(dir),
    punchFile: "punch.mp3",
    punchSec: 6,
    concat: async (inputs, out) => {
      seen = inputs.map((p) => path.basename(p));
      fs.writeFileSync(out, "BAKED");
    },
  });

  assert.deepEqual(seen, [
    "silence-ramp-3s.mp3",
    "lead.mp3",
    "punch.mp3",
    "silence-3s.mp3",
  ]);
  assert.equal(result.speechSec, 18);
  assert.equal(result.durationSec, 24);
});

test("an already-baked clip is reused instead of re-encoded", async () => {
  const dir = makeDir(PADS);
  let calls = 0;
  const concat = async (_inputs, out) => {
    calls += 1;
    fs.writeFileSync(out, "BAKED");
  };

  const first = await bakeAnnounceClip({ ...base(dir), concat });
  const second = await bakeAnnounceClip({ ...base(dir), concat });

  assert.equal(calls, 1);
  assert.equal(first.fileName, second.fileName);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
});

test("a truncated clip left by a crashed bake is re-encoded, not served", async () => {
  const dir = makeDir(PADS);
  const name = bakedAnnounceName({
    leadFile: "lead.mp3",
    punchFile: null,
    rampSec: 3,
    restoreSec: 3,
  });
  fs.writeFileSync(path.join(dir, name), "");

  let calls = 0;
  const result = await bakeAnnounceClip({
    ...base(dir),
    concat: async (_inputs, out) => {
      calls += 1;
      fs.writeFileSync(out, "BAKED");
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.cached, false);
  assert.equal(fs.readFileSync(result.filePath, "utf8"), "BAKED");
});

test("a failed encode leaves no file that a later run would treat as cached", async () => {
  const dir = makeDir(PADS);
  await assert.rejects(
    bakeAnnounceClip({
      ...base(dir),
      concat: async () => {
        throw new Error("ffmpeg concat failed (exit 1)");
      },
    }),
    /ffmpeg concat failed/
  );

  const name = bakedAnnounceName({
    leadFile: "lead.mp3",
    punchFile: null,
    rampSec: 3,
    restoreSec: 3,
  });
  assert.equal(fs.existsSync(path.join(dir, name)), false);
});

test("a missing source clip fails loudly instead of baking silence", async () => {
  const dir = makeDir({ "silence-ramp-3s.mp3": "RAMP", "silence-3s.mp3": "R" });
  await assert.rejects(
    bakeAnnounceClip({
      ...base(dir),
      concat: async () => assert.fail("should not reach ffmpeg"),
    }),
    /missing lead\.mp3/
  );
});
