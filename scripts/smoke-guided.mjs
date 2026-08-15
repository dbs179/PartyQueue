#!/usr/bin/env node
/**
 * Slow, narrated live smoke for listening along.
 *
 *   node --env-file-if-exists=.env scripts/smoke-guided.mjs
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
const PAUSE = Math.max(2000, Number(process.env.PQ_GUIDED_PAUSE_MS) || 8000);

function banner(title) {
  console.log("\n" + "=".repeat(64));
  console.log(`  ${title}`);
  console.log("=".repeat(64));
}

function expect(msg) {
  console.log(`\n>>> EXPECT TO HEAR: ${msg}\n`);
}

async function statusLine(tag = "") {
  const [n, v, q] = await Promise.all([np(), vol(), queueList()]);
  const tracks = Array.isArray(q) ? q : q?.tracks || [];
  const next = tracks
    .slice(0, 5)
    .map((t) => (t.djVoice ? "[DJ]" : t.title || "?"))
    .join(" → ");
  const bit = n?.djSilence
    ? "SILENCE RAMP"
    : n?.djVoice
      ? "DJ TTS"
      : n?.title || "(nothing)";
  console.log(
    `[${tag}] vol=${v} playing=${!!n?.isPlaying} now="${bit}" | up-next: ${next || "(empty)"}`
  );
  return { n, v, tracks };
}

async function pause(label) {
  console.log(`… pause ${PAUSE / 1000}s — ${label}`);
  await sleep(PAUSE);
}

async function waitForDj({ timeoutMs = 180000 } = {}) {
  expect(
    "silence ramp (brief quiet), THEN the DJ voice, THEN music again at baseline volume"
  );
  const started = Date.now();
  let sawSil = false;
  let sawDj = false;
  let restored = false;
  while (Date.now() - started < timeoutMs) {
    const { n, v } = await statusLine("watch");
    if (n?.djSilence) {
      if (!sawSil) {
        console.log("→ silence ramp is playing (volume may already be boosted)");
        sawSil = true;
      }
    }
    if (n?.djVoice && !n?.djSilence) {
      if (!sawDj) {
        console.log("→ DJ TTS is playing — listen for the shout-out now");
        sawDj = true;
      }
    }
    if (sawDj && !n?.djVoice && !n?.djSilence) {
      if (near(v, BASELINE, 3)) {
        console.log(`→ back on music; volume restored to ${v}`);
        restored = true;
        break;
      }
      console.log(`→ music again, volume still ${v} (want ~${BASELINE})…`);
    }
    await sleep(1000);
  }
  if (!sawDj) throw new Error("Never heard DJ TTS in the watch window.");
  if (!restored) {
    const v = await vol();
    throw new Error(`Volume not back near ${BASELINE} (got ${v}).`);
  }
}

async function skipTowardDj() {
  banner("Skip forward to the announce (slowly)");
  console.log(
    "Mid-queue shouts sit AFTER the requested songs. Skipping one track at a time."
  );
  for (let i = 0; i < 10; i++) {
    const { n } = await statusLine(`skip-${i + 1}`);
    if (n?.djVoice || n?.djSilence) {
      console.log("Announce pad is already current — stopping skips.");
      return;
    }
    const clips = countUpcomingDjClips(await queueList());
    if (clips < 1) {
      console.log("No upcoming DJ pad left.");
      return;
    }
    expect(`brief transition / next song (skip ${i + 1}) — not a second DJ yet`);
    await api("POST", "/api/next");
    await pause("after skip, let Sonos settle");
  }
}

async function addAs(name, track) {
  return api("POST", "/api/queue", {
    uri: track.uri,
    name: track.name,
    artist: track.artist,
    requestedBy: name,
    force: true,
  });
}

/** Force every searched add to shout for this run; restore afterward. */
async function withForcedShouts(fn) {
  const before = await api("GET", "/api/settings");
  const restore = {
    djShoutEnabled: before.djShoutEnabled,
    djShoutMode: before.djShoutMode,
    djShoutEveryN: before.djShoutEveryN,
    djShoutPercent: before.djShoutPercent,
    neverEnding: !!before.neverEnding,
  };
  console.log(
    "Forcing Mood Pulse every-add + pausing Never-Ending for this smoke only."
  );
  await api("POST", "/api/settings", {
    djShoutEnabled: true,
    djShoutMode: "every",
    djShoutEveryN: 1,
    neverEnding: false,
  });
  try {
    return await fn();
  } finally {
    console.log("Restoring Mood Pulse / Never-Ending settings…");
    try {
      await api("POST", "/api/settings", restore);
    } catch (e) {
      console.warn("settings restore:", e.message);
    }
  }
}

async function phaseSupersede() {
  banner("PHASE 1 — Announce supersede");
  console.log(`BASE=${BASE}  baseline volume target=${BASELINE}`);
    console.log(
    "Goal: two guest adds close together → BOTH request-glued shouts stay → songs in add order."
  );

  await ensureHostAuth();
  const health = await api("GET", "/api/health");
  console.log("health", health);

  await withForcedShouts(async () => {
    banner("Clear queue for a clean listen");
    expect("music stop / queue empty (may cut current song)");
    try {
      await api("POST", "/api/queue/clear");
    } catch (e) {
      console.warn("clear:", e.message);
    }
    await sleep(2000);

    const startVol = await nudgeVolumeTo(BASELINE);
    console.log(`volume set to ${startVol}`);

    banner("Seed music WITHOUT a DJ shout (avoids empty-queue announce hang)");
    const filler = await searchTrack("Mr Blue Sky ELO");
    expect(`music only: "${filler.name}" — no SmokeFiller / no DJ yet`);
    // Empty-queue adds always shout when Mood Pulse is on — that path hung us
    // on a STOPPED silence ramp. Seed with shouts off, then re-enable for Mark/Alex.
    await api("POST", "/api/settings", { djShoutEnabled: false });
    await addAs("SmokeFiller", filler);
    await sleep(800);
    try {
      await api("POST", "/api/play");
    } catch (e) {
      console.warn("seed play:", e.message);
    }
    await pause("let seed music actually play");
    {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        const { n } = await statusLine("seed-wait");
        if (n?.isPlaying && !n?.djVoice && !n?.djSilence) break;
        if (!n?.isPlaying) {
          try {
            await api("POST", "/api/play");
          } catch {
            /* ignore */
          }
        }
        await sleep(1000);
      }
      const { n } = await statusLine("seed");
      if (!n?.isPlaying || n?.djVoice || n?.djSilence) {
        throw new Error("Seed music never started — cannot test mid-queue supersede.");
      }
    }
    console.log("Re-enabling Mood Pulse every-add for Mark / Alex…");
    await api("POST", "/api/settings", {
      djShoutEnabled: true,
      djShoutMode: "every",
      djShoutEveryN: 1,
    });
    await sleep(500);

    const a = await searchTrack("Come On Eileen Dexys");
    const b = await searchTrack("Don't Stop Believin Journey");

    banner("Guest add #1 — Mark");
    expect(
      "usually NOTHING spoken yet (pad queues after the song). Mark's shout stays glued to his track."
    );
    console.log(`adding: ${a.name}`);
    await addAs("Mark", a);
    await pause("Mark's pad may enqueue; listening for accidental early shout");
    await statusLine("after-mark");
    console.log(
      `upcoming DJ clips: ${countUpcomingDjClips(await queueList())} (expect 1)`
    );

    banner("Guest add #2 — Alex (stacked request shout)");
    expect(
      "Alex's shout inserts before his track. Mark's unplayed shout stays."
    );
    console.log(`adding: ${b.name}`);
    await addAs("Alex", b);
    await pause("after Alex — both request shouts should still be queued");
    await statusLine("after-alex");
    const clips = countUpcomingDjClips(await queueList());
    console.log(`upcoming DJ TTS rows: ${clips}`);
    if (clips < 2) {
      throw new Error(
        `FAIL stacked shouts: expected both request shouts, found ${clips}`
      );
    }
    console.log("PASS check: both request-glued DJ pads queued after dual add.");

    await skipTowardDj();
    await waitForDj({ timeoutMs: 120000 });
    banner("PHASE 1 RESULT: PASS");
    console.log(
      "You should hear Mark's shout before his song, then later Alex's before his."
    );
  });
}

async function phaseSticky() {
  banner("PHASE 2 — Sticky volume (hard-cap from first boost)");
  console.log(
    "Goal: empty-queue add → volume boosts for announce → returns to baseline."
  );

  await pause("breather between phases — room should be calm");

  banner("Clear queue again");
  expect("cut to silence / empty");
  try {
    await api("POST", "/api/queue/clear");
  } catch (e) {
    console.warn("clear:", e.message);
  }
  await nudgeVolumeTo(BASELINE);
  await pause("after clear + volume baseline");

  const track = await searchTrack("Come On Eileen Dexys");
  banner("Empty-queue add — StickySmoke");
  expect(
    "DJ lead-in on an empty queue: silence ramp + louder DJ, then Come On Eileen at baseline volume"
  );
  console.log(`adding: ${track.name}`);

  const addPromise = addAs("StickySmoke", track);
  const started = Date.now();
  let boostedAt = null;
  let peak = BASELINE;

  while (Date.now() - started < 90000) {
    const { n, v } = await statusLine("sticky");
    peak = Math.max(peak, v);
    if (v >= BASELINE + 3 && (n?.djSilence || n?.djVoice)) {
      if (boostedAt == null) {
        boostedAt = Date.now();
        console.log(`→ boost detected at vol=${v} (peak will climb)`);
      }
    }
    if (
      boostedAt != null &&
      !n?.djVoice &&
      !n?.djSilence &&
      near(v, BASELINE, 3)
    ) {
      console.log(`→ restored to ${v} after announce`);
      break;
    }
    await sleep(1000);
  }
  await addPromise.catch(() => {});

  if (boostedAt == null) {
    throw new Error("Never saw volume boost — is DJ Voice on?");
  }
  const v = await vol();
  if (!near(v, BASELINE, 3)) {
    throw new Error(`Sticky FAIL: volume still ${v}, want ~${BASELINE}`);
  }
  console.log(`peak during announce=${peak}, final=${v}`);
  banner("PHASE 2 RESULT: PASS");
}

async function main() {
  banner("PartyQueue guided live smokes");
  console.log("Listen along. Phases are slowed so each moment is obvious.");
  console.log(
    "Unintended: two full DJ TTS clips back-to-back in Phase 1.\nIntended: one Phase-1 shout, later a separate Phase-2 shout."
  );

  await phaseSupersede();
  await phaseSticky();

  banner("ALL GUIDED SMOKES PASSED");
  await statusLine("final");
}

main().catch((err) => {
  console.error("\nFAIL:", err.message);
  process.exit(1);
});
