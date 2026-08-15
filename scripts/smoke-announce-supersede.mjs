#!/usr/bin/env node
/**
 * Live smoke: two back-to-back shout-worthy adds keep both request-glued
 * shouts (FIFO songs; each announce sits immediately before its track) and
 * restore music volume after the first DJ stretch.
 *
 *   node scripts/smoke-announce-supersede.mjs
 *   PQ_HOST_PIN=**** PQ_BASELINE=15 node scripts/smoke-announce-supersede.mjs
 */
import {
  api,
  ensureHostAuth,
  sleep,
  vol,
  np,
  queueList,
  near,
  nudgeVolumeTo,
  searchTrack,
  countUpcomingDjClips,
  BASE,
} from "./smoke-lib.mjs";

const BASELINE = Math.max(
  0,
  Math.min(100, Math.round(Number(process.env.PQ_BASELINE) || 15))
);

async function addAs(name, track) {
  return api("POST", "/api/queue", {
    uri: track.uri,
    name: track.name,
    artist: track.artist,
    requestedBy: name,
    force: true,
  });
}

async function main() {
  console.log(`BASE=${BASE}`);
  await ensureHostAuth();
  const health = await api("GET", "/api/health");
  console.log("health", health);

  const settings = await api("GET", "/api/settings").catch(() => null);
  if (settings && settings.djVoiceEnabled === false) {
    throw new Error("DJ Voice is off — enable it before supersede smoke.");
  }

  const startVol = await nudgeVolumeTo(BASELINE);
  console.log(`baseline volume=${startVol}`);

  // Prefer a non-empty queue so both shouts are mid-queue (pad supersede path).
  let status = await np();
  if (!status?.isPlaying) {
    const filler = await searchTrack("Mr Blue Sky ELO");
    await addAs("SmokeFiller", filler);
    await sleep(1500);
    try {
      await api("POST", "/api/play");
    } catch {
      /* may already be playing */
    }
    await sleep(2000);
    status = await np();
  }

  const a = await searchTrack("Come On Eileen Dexys");
  const b = await searchTrack("Don't Stop Believin Journey");

  console.log("add #1 (Mark)…");
  await addAs("Mark", a);
  await sleep(400);
  console.log("add #2 (Alex) immediately…");
  await addAs("Alex", b);
  await sleep(1200);

  const q = await queueList();
  const djClips = countUpcomingDjClips(q);
  console.log(`upcoming DJ TTS rows after dual add: ${djClips}`);

  // Guest list hides silence ramps. Both request shouts must stay glued.
  if (djClips < 2) {
    throw new Error(
      `Expected both request shouts to stay in queue, found ${djClips}`
    );
  }

  // Mid-queue shouts sit after the requested tracks — skip music until the
  // announce pad is imminent so this smoke finishes in ~a minute, not a song.
  for (let i = 0; i < 8; i++) {
    const cur = await np();
    if (cur?.djVoice || cur?.djSilence) break;
    const ahead = countUpcomingDjClips(await queueList());
    if (ahead < 1) break;
    console.log(`skip to announce (${i + 1})… now=${cur?.title || "?"}`);
    try {
      await api("POST", "/api/next");
    } catch (e) {
      console.warn("next:", e.message);
      break;
    }
    await sleep(1500);
  }

  // Watch for a single DJ stretch then music + volume restore.
  let sawDj = false;
  let djEnded = false;
  let restored = false;
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const [cur, v] = await Promise.all([np(), vol()]);
    const onDj = !!(cur?.djVoice && !cur?.djSilence);
    const onSil = !!cur?.djSilence;
    if (onDj) sawDj = true;
    if (onSil && !sawDj) {
      // Ramp counts as announce path started; TTS should follow.
    }
    if (sawDj && !onDj && !onSil) {
      djEnded = true;
      if (near(v, BASELINE, 3)) {
        restored = true;
        console.log(`volume restored to ${v} after DJ`);
        break;
      }
    }
    if (djEnded && near(v, BASELINE, 3)) {
      restored = true;
      break;
    }
    await sleep(300);
  }

  if (!sawDj) throw new Error("Never saw a DJ clip after dual add.");
  if (!restored) {
    const v = await vol();
    throw new Error(`Volume not restored to ~${BASELINE} after supersede (got ${v})`);
  }

  console.log("PASS smoke-announce-supersede");
}

main().catch((err) => {
  console.error("FAIL", err.message);
  process.exit(1);
});
