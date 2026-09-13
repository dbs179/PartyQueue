import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  ABSORB_MAX_ISLAND_SEC,
  CUT_PAD_SEC,
  INHALE_HOP_SEC,
  findInhaleCutSec,
  rmsWindowsFromPcm,
  speechIslands,
  trimTtsTrailingInhale,
} from "../src/tts-inhale-trim.js";

function windowsFromPairs(pairs) {
  const out = [];
  for (const [sec, db] of pairs) {
    const n = Math.round(sec / INHALE_HOP_SEC);
    for (let i = 0; i < n; i += 1) out.push(db);
  }
  return out;
}

test("speech islands merge brief dips inside a phrase", () => {
  const rms = windowsFromPairs([
    [0.4, -12],
    [0.1, -34],
    [0.4, -12],
    [0.25, -40],
    [0.7, -14],
  ]);
  const islands = speechIslands(rms);
  assert.equal(islands.length, 2);
  assert.equal((islands[0].end - islands[0].start) * INHALE_HOP_SEC, 0.9);
  assert.ok(
    Math.abs((islands[1].end - islands[1].start) * INHALE_HOP_SEC - 0.7) < 1e-9
  );
});

test("cuts an isolated speech-level gasp after the last phrase", () => {
  // Sister Static pattern: last phrase, 250ms hole, then a ~0.7s inhale.
  const rms = windowsFromPairs([
    [2.0, -12],
    [0.25, -40],
    [0.7, -14],
    [0.2, -38],
  ]);
  const cut = findInhaleCutSec(rms);
  assert.equal(cut, 2 + CUT_PAD_SEC);
});

test("ignores a leftover breath crumb after the inhale", () => {
  const rms = windowsFromPairs([
    [1.8, -12],
    [0.2, -40],
    [0.2, -16],
    [0.1, -30],
    [0.4, -10],
    [0.3, -38],
    [0.1, -20],
  ]);
  assert.equal(findInhaleCutSec(rms), 1.8 + CUT_PAD_SEC);
});

test("absorbs a split inhale that has a short quiet dip in the middle", () => {
  const rms = windowsFromPairs([
    [1.8, -12],
    [0.25, -40],
    [0.15, -16],
    [0.15, -30],
    [0.4, -10],
    [0.15, -38],
  ]);
  const cut = findInhaleCutSec(rms);
  assert.equal(cut, 1.8 + CUT_PAD_SEC);
  assert.ok(
    ABSORB_MAX_ISLAND_SEC > 0.15,
    "short inhale fragments must be absorbable"
  );
});

test("keeps a short last word after a sentence-length pause", () => {
  const rms = windowsFromPairs([
    [2.0, -12],
    [0.5, -40],
    [0.25, -10],
  ]);
  assert.equal(findInhaleCutSec(rms), null);
});

test("does not cut when the clip ends on the last phrase", () => {
  const rms = windowsFromPairs([
    [2.4, -12],
    [0.15, -40],
  ]);
  assert.equal(findInhaleCutSec(rms), null);
});

test("does not cut a later sentence after a short pause", () => {
  const rms = windowsFromPairs([
    [1.2, -12],
    [0.2, -40],
    [2.0, -12],
  ]);
  assert.equal(findInhaleCutSec(rms), null);
});

test("rms windows match hop size", () => {
  const rate = 8000;
  const hop = Math.round(rate * INHALE_HOP_SEC);
  const samples = new Float32Array(hop * 4);
  samples.fill(0.2);
  assert.equal(rmsWindowsFromPcm(samples, rate).length, 4);
});

function resolveTestFfmpeg() {
  const fromEnv = String(process.env.FFMPEG_PATH || "").trim();
  const candidates = [
    fromEnv,
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
    "ffmpeg",
  ].filter(Boolean);
  for (const bin of candidates) {
    const probe = spawnSync(bin, ["-version"], { encoding: "utf8" });
    if (probe.status === 0) return bin;
  }
  return null;
}

test("ffmpeg trim drops a synthetic trailing gasp", async (t) => {
  const ffmpegBin = resolveTestFfmpeg();
  if (!ffmpegBin) {
    t.skip("ffmpeg is not installed");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pq-inhale-"));
  const src = path.join(dir, "clip.mp3");
  const made = spawnSync(
    ffmpegBin,
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2.0",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=mono:d=0.25",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=180:duration=0.7",
      "-filter_complex",
      "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
      "-map",
      "[out]",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      src,
    ],
    { encoding: "utf8" }
  );
  assert.equal(made.status, 0, made.stderr);
  const result = await trimTtsTrailingInhale(src, { ffmpegBin });
  assert.equal(result.trimmed, true);
  assert.ok(result.cutSec >= 1.95 && result.cutSec <= 2.15);
  assert.ok(result.removedSec >= 0.6);
  fs.rmSync(dir, { recursive: true, force: true });
});
