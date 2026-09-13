// ElevenLabs often appends a loud gasp / inhale after the last word.
// It is not silence — it can be speech-level — so a mute-trim misses it.
// We look for a short isolated burst after the last real phrase and cut there.

import fs from "node:fs";
import { spawn } from "node:child_process";

export const INHALE_HOP_SEC = 0.05;
export const SPEECH_RMS_DB = -22;
export const MERGE_GAP_SEC = 0.15;
export const INHALE_MIN_SEC = 0.4;
export const INHALE_MAX_SEC = 1.2;
export const INHALE_GAP_MIN_SEC = 0.15;
export const INHALE_GAP_MAX_SEC = 0.4;
export const ABSORB_MAX_ISLAND_SEC = 0.35;
export const ABSORB_GAP_SEC = 0.2;
export const CUT_PAD_SEC = 0.05;
export const MIN_KEEP_SEC = 0.8;
export const MAX_TRIM_SEC = 1.6;
export const FADE_OUT_SEC = 0.04;
export const PCM_RATE = 8000;

/**
 * @param {number[]} samples
 * @param {number} start
 * @param {number} len
 */
export function rmsDb(samples, start, len) {
  let sum = 0;
  const end = Math.min(samples.length, start + len);
  const n = end - start;
  if (n <= 0) return -120;
  for (let i = start; i < end; i += 1) {
    const s = samples[i];
    sum += s * s;
  }
  const rms = Math.sqrt(sum / n);
  return rms > 1e-9 ? 20 * Math.log10(rms) : -120;
}

/**
 * @param {Float32Array|number[]} samples
 * @param {number} [rate]
 */
export function rmsWindowsFromPcm(samples, rate = PCM_RATE) {
  const hop = Math.max(1, Math.round(rate * INHALE_HOP_SEC));
  const windows = [];
  for (let i = 0; i + hop <= samples.length; i += hop) {
    windows.push(rmsDb(samples, i, hop));
  }
  return windows;
}

/**
 * @param {{ start: number, end: number }} island
 * @param {number} hopSec
 */
function islandDur(island, hopSec) {
  return Math.max(0, (island.end - island.start) * hopSec);
}

/**
 * Merge nearby speech windows into phrase islands.
 * @param {number[]} rmsDbWindows
 * @param {number} hopSec
 */
export function speechIslands(rmsDbWindows, hopSec = INHALE_HOP_SEC) {
  const speech = rmsDbWindows.map((db) => Number(db) > SPEECH_RMS_DB);
  const mergeWindows = Math.max(1, Math.round(MERGE_GAP_SEC / hopSec));
  const islands = [];
  let i = 0;
  while (i < speech.length) {
    if (!speech[i]) {
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < speech.length) {
      if (speech[end]) {
        end += 1;
        continue;
      }
      let look = end;
      while (
        look < speech.length &&
        !speech[look] &&
        look - end <= mergeWindows
      ) {
        look += 1;
      }
      if (
        look < speech.length &&
        speech[look] &&
        look - end <= mergeWindows
      ) {
        end = look;
        continue;
      }
      break;
    }
    islands.push({ start: i, end });
    i = end;
  }
  return islands;
}

/**
 * Seconds to keep, or null when the clip should be left alone.
 * @param {number[]} rmsDbWindows
 * @param {number} [hopSec]
 * @returns {number|null}
 */
export function findInhaleCutSec(rmsDbWindows, hopSec = INHALE_HOP_SEC) {
  if (!Array.isArray(rmsDbWindows) || rmsDbWindows.length < 8) return null;
  const durationSec = rmsDbWindows.length * hopSec;
  const islands = speechIslands(rmsDbWindows, hopSec);
  // A leftover breath crumb at EOF must not become "the inhale".
  while (islands.length >= 2) {
    const last = islands[islands.length - 1];
    const nearEnd = last.start * hopSec >= durationSec - 0.4;
    if (islandDur(last, hopSec) < 0.18 && nearEnd) {
      islands.pop();
      continue;
    }
    break;
  }
  if (islands.length < 2) return null;

  let tailStart = islands.length - 1;
  let tail = [islands[tailStart]];
  while (tailStart > 0) {
    const prev = islands[tailStart - 1];
    const cur = islands[tailStart];
    const gap = (cur.start - prev.end) * hopSec;
    if (islandDur(prev, hopSec) >= ABSORB_MAX_ISLAND_SEC) break;
    if (gap > ABSORB_GAP_SEC) break;
    tailStart -= 1;
    tail = [prev, ...tail];
  }

  const firstTail = tail[0];
  const lastTail = tail[tail.length - 1];
  const tailSpeechSec = tail.reduce((sum, isle) => sum + islandDur(isle, hopSec), 0);
  const tailPrev = islands[tailStart - 1];
  if (!tailPrev) return null;

  const gap = (firstTail.start - tailPrev.end) * hopSec;
  if (tailSpeechSec < INHALE_MIN_SEC || tailSpeechSec > INHALE_MAX_SEC) return null;
  if (gap < INHALE_GAP_MIN_SEC || gap > INHALE_GAP_MAX_SEC) return null;

  const after = rmsDbWindows.slice(lastTail.end);
  const afterSpeechSec =
    after.filter((db) => Number(db) > SPEECH_RMS_DB).length * hopSec;
  if (afterSpeechSec >= 0.18) return null;

  const cut = tailPrev.end * hopSec + CUT_PAD_SEC;
  if (cut < MIN_KEEP_SEC) return null;
  if (durationSec - cut > MAX_TRIM_SEC) return null;
  if (cut >= durationSec - hopSec) return null;
  return Math.round(cut * 1000) / 1000;
}

function runFfmpeg(ffmpegBin, args, { captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin, args, {
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"],
    });
    const chunks = [];
    let stderr = "";
    if (captureStdout) {
      child.stdout.on("data", (chunk) => chunks.push(chunk));
    }
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (err) =>
      reject(new Error(`ffmpeg not available (${err.message})`))
    );
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-3).join(" | ");
        reject(new Error(`ffmpeg inhale trim failed (exit ${code}): ${tail}`));
        return;
      }
      resolve(captureStdout ? Buffer.concat(chunks) : undefined);
    });
  });
}

/**
 * Decode a TTS mp3 to mono float32 PCM.
 * @param {string} inputPath
 * @param {string} ffmpegBin
 */
export async function decodeTtsPcm(inputPath, ffmpegBin = "ffmpeg") {
  const buf = await runFfmpeg(
    ffmpegBin,
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      inputPath,
      "-f",
      "f32le",
      "-ac",
      "1",
      "-ar",
      String(PCM_RATE),
      "pipe:1",
    ],
    { captureStdout: true }
  );
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

/**
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {number} endSec
 * @param {string} ffmpegBin
 */
export async function writeTrimmedTts(inputPath, outputPath, endSec, ffmpegBin = "ffmpeg") {
  const fadeStart = Math.max(0, endSec - FADE_OUT_SEC);
  await runFfmpeg(ffmpegBin, [
    "-y",
    "-hide_banner",
    "-nostdin",
    "-i",
    inputPath,
    "-af",
    `atrim=0:${endSec},asetpts=PTS-STARTPTS,afade=t=out:st=${fadeStart}:d=${FADE_OUT_SEC}`,
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
    "-ar",
    "44100",
    "-ac",
    "1",
    "-vn",
    "-f",
    "mp3",
    outputPath,
  ]);
}

/**
 * Trim a trailing ElevenLabs inhale in place when the pattern is present.
 * @param {string} filePath
 * @param {{ ffmpegBin?: string }} [opts]
 * @returns {Promise<{ trimmed: boolean, cutSec: number|null, removedSec: number }>}
 */
export async function trimTtsTrailingInhale(filePath, { ffmpegBin = "ffmpeg" } = {}) {
  const samples = await decodeTtsPcm(filePath, ffmpegBin);
  const windows = rmsWindowsFromPcm(samples);
  const cutSec = findInhaleCutSec(windows);
  if (cutSec == null) {
    return { trimmed: false, cutSec: null, removedSec: 0 };
  }
  const durationSec = windows.length * INHALE_HOP_SEC;
  const tmpPath = `${filePath}.inhale-trim.mp3`;
  try {
    await writeTrimmedTts(filePath, tmpPath, cutSec, ffmpegBin);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
  return {
    trimmed: true,
    cutSec,
    removedSec: Math.round((durationSec - cutSec) * 1000) / 1000,
  };
}
