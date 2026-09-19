// Bake an announce into ONE mp3: ramp silence + lead DJ clip + optional banter
// punch + restore silence.
//
// Why this exists: the announce used to occupy three or four contiguous Sonos
// queue rows. Keeping that run intact across trims, skips and supersedes is
// where nearly every DJ bug came from, and shepherding the playhead between the
// rows is why the volume handoff had to issue SeekTrack/Pause/Play/Next at all.
// A single row cannot be split, cannot be half-trimmed, and needs no transport
// commands: the volume ramp becomes a function of elapsed time inside the clip.
//
// The silence is still real audio, so the volume change stays inaudible exactly
// as it did when the pads were their own rows.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/** Bitrate/rate/channels for the baked clip. Fixed so duration metadata is exact. */
export const BAKED_BITRATE = "128k";
export const BAKED_SAMPLE_RATE = 44100;
export const BAKED_CHANNELS = 2;

/** Marker in the filename so queue-policy can recognise a baked announce. */
export const BAKED_PREFIX = "dj-announce-";

/**
 * True when this URI is a single-row baked announce.
 * @param {string|null|undefined} uri
 */
export function isBakedAnnounceUri(uri) {
  return new RegExp(`${BAKED_PREFIX}[0-9a-f]{16}\\.mp3`, "i").test(
    String(uri || "")
  );
}

/**
 * Stable name for a baked announce. Derived from the parts rather than the
 * audio bytes so a cache hit costs one stat() instead of re-reading the inputs.
 *
 * @param {{ leadFile: string, punchFile?: string|null, rampSec: number, restoreSec: number }} parts
 */
export function bakedAnnounceName({
  leadFile,
  punchFile = null,
  rampSec,
  restoreSec,
}) {
  const key = [
    String(leadFile || ""),
    String(punchFile || ""),
    Number(rampSec) || 0,
    Number(restoreSec) || 0,
  ].join("|");
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  return `${BAKED_PREFIX}${hash}.mp3`;
}

/**
 * Run ffmpeg to concatenate the parts. Re-encodes rather than stream-copying:
 * ElevenLabs clips and the bundled silence do not share sample rate or bitrate,
 * and a copy-concat of mismatched mp3s yields a file whose reported duration is
 * wrong — which Sonos then uses to decide when the track ends.
 *
 * @param {string[]} inputs absolute paths, in play order
 * @param {string} outputPath
 * @param {string} ffmpegBin
 */
export function concatWithFfmpeg(inputs, outputPath, ffmpegBin = "ffmpeg") {
  return new Promise((resolve, reject) => {
    const args = ["-y"];
    for (const input of inputs) args.push("-i", input);
    // concat refuses inputs whose sample rate or channel layout differ, and
    // they always do here: the bundled silence is 32 kb/s stereo while an
    // ElevenLabs clip is 128 kb/s mono. Normalise every input first.
    const normalise = inputs
      .map(
        (_, i) =>
          `[${i}:a]aformat=sample_fmts=fltp:sample_rates=${BAKED_SAMPLE_RATE}:` +
          `channel_layouts=stereo[a${i}];`
      )
      .join("");
    const chain = inputs.map((_, i) => `[a${i}]`).join("");
    args.push(
      "-filter_complex",
      `${normalise}${chain}concat=n=${inputs.length}:v=0:a=1[out]`,
      "-map",
      "[out]",
      "-c:a",
      "libmp3lame",
      "-b:a",
      BAKED_BITRATE,
      "-ar",
      String(BAKED_SAMPLE_RATE),
      "-ac",
      String(BAKED_CHANNELS),
      "-vn",
      // Stated explicitly because the encode writes to a `.part` file first and
      // ffmpeg cannot infer the muxer from that extension.
      "-f",
      "mp3",
      outputPath
    );
    const child = spawn(ffmpegBin, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (err) =>
      reject(new Error(`ffmpeg not available (${err.message})`))
    );
    child.on("close", (code) => {
      if (code === 0) return resolve();
      // Without the tail, a layout/rate mismatch surfaces only as an exit code.
      const tail = stderr.trim().split("\n").slice(-3).join(" | ");
      reject(new Error(`ffmpeg concat failed (exit ${code}): ${tail}`));
    });
  });
}

/**
 * Parse `Duration: HH:MM:SS.xx` from ffmpeg/ffprobe info text.
 * @param {string} text
 * @returns {number|null}
 */
export function durationSecFromFfmpegInfo(text) {
  const match = String(text || "").match(
    /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i
  );
  if (!match) return null;
  const sec =
    Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

/**
 * Measure an audio file with ffmpeg. Byte-length guesses assume 64 kbps and
 * roughly double a 128 kbps ElevenLabs clip — which is how the restore ramp
 * landed 20s into the next song.
 *
 * `ffmpeg -i` always exits non-zero when no output is given; duration is on
 * stderr either way.
 *
 * @param {string} filePath
 * @param {string} [ffmpegBin]
 * @returns {Promise<number|null>}
 */
export function probeAudioDurationSec(filePath, ffmpegBin = "ffmpeg") {
  const target = String(filePath || "");
  if (!target) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(ffmpegBin, ["-i", target], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(durationSecFromFfmpegInfo(stderr)));
  });
}

function applyMeasuredDuration(result, measured) {
  const duration = Number(measured);
  if (!Number.isFinite(duration) || duration <= 0) return result;
  result.durationSec = duration;
  result.speechSec = Math.max(
    0,
    duration - (Number(result.rampSec) || 0) - (Number(result.restoreSec) || 0)
  );
  return result;
}

/**
 * Produce (or reuse) the one-file announce.
 *
 * `rampSec` is the silence before the DJ speaks and `restoreSec` the silence
 * after. Duration is measured from the baked file: a 128 kbps ElevenLabs clip
 * is about twice as long by byte-length as our 64 kbps guess, and that lag
 * is what kept the restore ramp (and Now Playing) on the DJ after the song
 * started.
 *
 * @param {{
 *   ttsDir: string,
 *   leadFile: string,
 *   punchFile?: string|null,
 *   rampFile: string,
 *   restoreFile: string,
 *   rampSec: number,
 *   restoreSec: number,
 *   leadSec: number,
 *   punchSec?: number,
 *   publicBaseUrl: string,
 *   ffmpegBin?: string,
 *   concat?: (inputs: string[], out: string, bin: string) => Promise<void>,
 *   probeDuration?: (filePath: string, bin: string) => Promise<number|null>,
 * }} opts
 */
export async function bakeAnnounceClip({
  ttsDir,
  leadFile,
  punchFile = null,
  rampFile,
  restoreFile,
  rampSec,
  restoreSec,
  leadSec,
  punchSec = 0,
  publicBaseUrl,
  ffmpegBin = "ffmpeg",
  concat = concatWithFfmpeg,
  probeDuration = probeAudioDurationSec,
}) {
  const fileName = bakedAnnounceName({
    leadFile,
    punchFile,
    rampSec,
    restoreSec,
  });
  const outputPath = path.join(ttsDir, fileName);
  const speechSec = (Number(leadSec) || 0) + (Number(punchSec) || 0);
  const result = {
    fileName,
    filePath: outputPath,
    publicUrl: `${publicBaseUrl}/media/tts/${fileName}`,
    rampSec: Number(rampSec) || 0,
    restoreSec: Number(restoreSec) || 0,
    speechSec,
    durationSec: (Number(rampSec) || 0) + speechSec + (Number(restoreSec) || 0),
    cached: false,
  };

  // A zero-byte file means a previous bake died mid-write; treat it as a miss.
  const existing = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null;
  if (existing && existing.size > 0) {
    result.cached = true;
    return applyMeasuredDuration(
      result,
      await probeDuration(outputPath, ffmpegBin)
    );
  }

  const inputs = [
    path.join(ttsDir, rampFile),
    path.join(ttsDir, leadFile),
    ...(punchFile ? [path.join(ttsDir, punchFile)] : []),
    path.join(ttsDir, restoreFile),
  ];
  for (const input of inputs) {
    if (!fs.existsSync(input)) {
      throw new Error(`cannot bake announce: missing ${path.basename(input)}`);
    }
  }

  // Write to a temp name and rename, so a crash mid-encode cannot leave a
  // truncated clip that later looks like a valid cache hit.
  const tempPath = `${outputPath}.part`;
  await concat(inputs, tempPath, ffmpegBin);
  fs.renameSync(tempPath, outputPath);
  return applyMeasuredDuration(
    result,
    await probeDuration(outputPath, ffmpegBin)
  );
}
