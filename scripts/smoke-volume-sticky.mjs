#!/usr/bin/env node
/**
 * Live smoke: volume hard-cap starts at first boost (not DJ URI).
 * After boost, volume must return to baseline within the hard-cap window
 * even if the announce pads linger.
 *
 *   node scripts/smoke-volume-sticky.mjs
 *   PQ_HOST_PIN=**** PQ_BASELINE=15 node scripts/smoke-volume-sticky.mjs
 */
import {
  api,
  ensureHostAuth,
  sleep,
  vol,
  np,
  near,
  nudgeVolumeTo,
  searchTrack,
  BASE,
} from "./smoke-lib.mjs";

const BASELINE = Math.max(
  0,
  Math.min(100, Math.round(Number(process.env.PQ_BASELINE) || 15))
);
// Matches dj-voice hard-cap slack (clip ≈8s + silence + 5s pad) with margin.
const HARD_CAP_WAIT_MS = Number(process.env.PQ_HARD_CAP_MS) || 25000;

async function main() {
  console.log(`BASE=${BASE}`);
  await ensureHostAuth();
  const health = await api("GET", "/api/health");
  console.log("health", health);

  const startVol = await nudgeVolumeTo(BASELINE);
  console.log(`baseline volume=${startVol}`);

  try {
    await api("POST", "/api/queue/clear");
  } catch (e) {
    console.warn("clear:", e.message);
  }
  await sleep(800);

  const track = await searchTrack("Come On Eileen Dexys");
  console.log("queue add to force empty-queue shout…");
  const addPromise = api("POST", "/api/queue", {
    uri: track.uri,
    name: track.name,
    artist: track.artist,
    requestedBy: "StickySmoke",
    force: true,
  });

  let boostedAt = null;
  let peak = startVol;
  const started = Date.now();
  while (Date.now() - started < 60000) {
    const [n, v] = await Promise.all([np(), vol()]);
    peak = Math.max(peak, v);
    if (v >= BASELINE + 3 && (n?.djSilence || (n?.djVoice && !n?.djSilence))) {
      if (boostedAt == null) {
        boostedAt = Date.now();
        console.log(`boost detected vol=${v} at t=${boostedAt - started}ms`);
      }
    }
    if (boostedAt != null && Date.now() - boostedAt >= HARD_CAP_WAIT_MS) {
      break;
    }
    await sleep(250);
  }
  await addPromise.catch(() => {});

  if (boostedAt == null) {
    throw new Error("Never saw a volume boost on ramp/DJ — is DJ Voice on?");
  }
  if (peak < BASELINE + 3) {
    throw new Error(`Peak volume ${peak} never rose above baseline ${BASELINE}`);
  }

  // Poll a bit longer for restore to land.
  let restored = false;
  const restoreDeadline = Date.now() + 15000;
  while (Date.now() < restoreDeadline) {
    const v = await vol();
    if (near(v, BASELINE, 3)) {
      restored = true;
      console.log(`volume back at ${v} (baseline ${BASELINE})`);
      break;
    }
    await sleep(300);
  }

  if (!restored) {
    const v = await vol();
    throw new Error(
      `Sticky volume: still ${v} after hard-cap window (want ~${BASELINE})`
    );
  }

  console.log("PASS smoke-volume-sticky");
}

main().catch((err) => {
  console.error("FAIL", err.message);
  process.exit(1);
});
