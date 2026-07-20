#!/usr/bin/env node
/**
 * Edge-case volume / DJ handoff smokes against a live PartyQueue + Sonos.
 *
 *   node scripts/smoke-volume-edges.mjs [all|skip-dj|skip-sil|overlap|defer|high|double|refill|media]
 */
import fs from "node:fs";

const BASE = process.env.PQ_BASE || "http://127.0.0.1:8088";
const WHICH = (process.argv[2] || "all").toLowerCase();
const BASELINE = Math.max(
  0,
  Math.min(100, Math.round(Number(process.env.PQ_BASELINE) || 20))
);
const POLL_MS = 250;
const LOG = [];
const REPORTS = [];

function ts() {
  return new Date().toISOString().slice(11, 23);
}

async function api(method, path, body, timeoutMs = 180000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 220)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

const vol = async () => Number((await api("GET", "/api/volume")).volume);
const np = () => api("GET", "/api/nowplaying");
const queueList = () => api("GET", "/api/queue/list");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function nudgeVolumeTo(target) {
  let v = await vol();
  let guard = 0;
  while (Math.abs(v - target) > 1 && guard++ < 50) {
    const step = Math.min(5, Math.abs(target - v));
    await api("POST", `/api/volume/${v < target ? "up" : "down"}?step=${step}`);
    await sleep(280);
    v = await vol();
  }
  return v;
}

function sample(label, n, v) {
  const row = {
    t: ts(),
    label,
    vol: v,
    title: n?.title || null,
    state: n?.state || null,
    // NP marks silence pads as djVoice too — real TTS is djVoice && !djSilence.
    dj: !!(n?.djVoice && !n?.djSilence),
    silence: !!n?.djSilence,
  };
  LOG.push(row);
  console.log(
    `${row.t} [${label}] vol=${row.vol} dj=${row.dj} sil=${row.silence} ${row.state} | ${row.title || "-"}`
  );
  return row;
}

async function searchTrack(q) {
  const j = await api("GET", `/api/search?q=${encodeURIComponent(q)}`);
  const t = (j.tracks || [])[0];
  if (!t?.uri) throw new Error(`No search hit for ${q}`);
  return {
    uri: t.uri,
    name: t.name,
    artist: t.artist || t.artists || "Unknown",
  };
}

async function clearQueue() {
  try {
    await api("POST", "/api/queue/clear");
  } catch (e) {
    console.warn("clear:", e.message);
  }
  await sleep(900);
}

async function waitMusic(label, baseline, maxMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const [n, v] = await Promise.all([np(), vol()]);
    sample(label, n, v);
    if (n?.state === "PLAYING" && !n.djVoice && !n.djSilence && n.title) {
      return { n, v, baselineOk: Math.abs(v - baseline) <= 3 };
    }
    await sleep(POLL_MS);
  }
  throw new Error(`${label}: timed out waiting for music`);
}

async function waitDj(label, maxMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const [n, v] = await Promise.all([np(), vol()]);
    sample(label, n, v);
    if (n?.djVoice && !n.djSilence) return { n, v };
    await sleep(POLL_MS);
  }
  throw new Error(`${label}: timed out waiting for DJ`);
}

function pass(label, ok, detail) {
  const report = { label, pass: !!ok, ...detail };
  REPORTS.push(report);
  console.log(`\n>> ${ok ? "PASS" : "FAIL"} ${label}`, JSON.stringify(detail));
  return report;
}

async function startFreshRandom(count = 4) {
  await clearQueue();
  const baseline = await nudgeVolumeTo(BASELINE);
  const res = await api("POST", "/api/queue/random", { count }, 180000);
  console.log("random", {
    added: res.added,
    announced: res.announced,
    started: res.started,
  });
  return baseline;
}

/** Edge: skip during DJ — volume must restore, not stay boosted. */
async function edgeSkipDuringDj() {
  console.log("\n=== EDGE: skip during DJ ===");
  const baseline = await startFreshRandom(3);
  await waitDj("skip-dj-wait", 60000);
  // Confirm boosted, then skip away from DJ/silence.
  let boosted = false;
  for (let i = 0; i < 20; i++) {
    const [n, v] = await Promise.all([np(), vol()]);
    sample("skip-dj", n, v);
    if (v >= baseline + 3) boosted = true;
    if (boosted && n.djVoice && !n.djSilence) break;
    await sleep(POLL_MS);
  }
  await api("POST", "/api/next");
  await sleep(1500);
  await api("POST", "/api/next"); // clear silence if landed there
  const after = [];
  for (let i = 0; i < 16; i++) {
    const [n, v] = await Promise.all([np(), vol()]);
    after.push(sample("skip-dj-after", n, v));
    await sleep(POLL_MS);
  }
  const music = after.find((s) => !s.dj && !s.silence && s.state === "PLAYING" && s.title);
  const restored = after.some(
    (s) => !s.dj && Math.abs(s.vol - baseline) <= 3
  );
  const stuckLoud = after.filter((s) => !s.dj && !s.silence).every((s) => s.vol >= baseline + 8);
  return pass("skip-during-dj", boosted && restored && !stuckLoud && !!music, {
    baseline,
    boosted,
    restored,
    stuckLoud,
    musicTitle: music?.title || null,
    musicVol: music?.vol ?? null,
  });
}

/** Edge: skip during pre-DJ ramp silence — eventually music at baseline. */
async function edgeSkipDuringSilence() {
  console.log("\n=== EDGE: skip during pre-DJ ramp silence ===");
  const baseline = await startFreshRandom(3);
  // Catch the lead ramp pad (post-DJ silence was removed in 5.9).
  const started = Date.now();
  let sawSil = false;
  while (Date.now() - started < 45000) {
    const [n, v] = await Promise.all([np(), vol()]);
    sample("skip-sil-wait", n, v);
    if (n.djSilence) {
      sawSil = true;
      break;
    }
    await sleep(POLL_MS);
  }
  if (!sawSil) {
    return pass("skip-during-silence", false, { reason: "never saw ramp silence" });
  }
  await api("POST", "/api/next"); // leave ramp (may land on DJ)
  await sleep(800);
  // If we landed on DJ, skip once more so music can play / restore can finish.
  {
    const n = await np();
    if (n?.djVoice && !n?.djSilence) await api("POST", "/api/next");
  }
  const isMusic = (s) =>
    !s.dj &&
    !s.silence &&
    !!s.title &&
    (s.state === "PLAYING" || s.state === "TRANSITIONING");
  const after = [];
  for (let i = 0; i < 36; i++) {
    const [n, v] = await Promise.all([np(), vol()]);
    after.push(sample("skip-sil-after", n, v));
    // Require music *at baseline* before early exit — a loud TRANSITIONING
    // blip alone must not end the poll window (false stuck-loud / unsettled).
    if (
      after.some(
        (s) => isMusic(s) && s.state === "PLAYING" && Math.abs(s.vol - baseline) <= 3
      )
    ) {
      // A couple more polls to confirm we are not stuck loud.
      for (let j = 0; j < 4; j++) {
        await sleep(POLL_MS);
        const [n2, v2] = await Promise.all([np(), vol()]);
        after.push(sample("skip-sil-after", n2, v2));
      }
      break;
    }
    await sleep(POLL_MS);
  }
  const musicSamples = after.filter(isMusic);
  const playing = musicSamples.filter((s) => s.state === "PLAYING");
  const music = playing[0] || musicSamples.find((s) => Math.abs(s.vol - baseline) <= 3) || null;
  // Allow a brief loud blip on the first music poll; require settled baseline.
  const settled = musicSamples
    .slice(0, 12)
    .some((s) => Math.abs(s.vol - baseline) <= 3);
  // Stuck-loud only if *trailing* music samples stay boosted (ignore first blip).
  const trailing = (playing.length ? playing : musicSamples).slice(-6);
  const stuckLoud =
    trailing.length > 0 && trailing.every((s) => s.vol >= baseline + 8);
  const ok = !!music && settled && !stuckLoud;
  return pass("skip-during-silence", ok, {
    baseline,
    musicTitle: music?.title || null,
    musicVol: music?.vol ?? null,
    settled,
    stuckLoud,
    musicSamples: musicSamples.length,
    playingSamples: playing.length,
  });
}

/**
 * Edge: enqueue mid-set shout WHILE fresh-set DJ is still speaking.
 * Old bug: superseding session cancelled restore → stuck loud.
 */
async function edgeOverlapDuringDj() {
  console.log("\n=== EDGE: request during fresh-set DJ (overlap) ===");
  const baseline = await startFreshRandom(4);
  await waitDj("overlap-dj", 60000);
  const during = await vol();
  const track = await searchTrack("Billie Jean Michael Jackson");
  console.log("overlap add while DJ speaking, vol=", during);
  const addPromise = api(
    "POST",
    "/api/queue",
    {
      uri: track.uri,
      name: track.name,
      artist: track.artist,
      requestedBy: "EdgeOverlap",
    },
    180000
  );
  // Keep sampling through add + remainder of current DJ
  const samples = [];
  const poller = (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      const [n, v] = await Promise.all([np(), vol()]);
      samples.push(sample("overlap", n, v));
      await sleep(POLL_MS);
    }
  })();
  const addRes = await addPromise;
  console.log("overlap add", {
    abs: addRes.absoluteQueuePosition,
    qp: addRes.queuePosition,
  });
  // Finish current handoff / get to music
  await sleep(2000);
  // Skip ahead carefully to music if still on DJ from fresh set
  for (let i = 0; i < 4; i++) {
    const n = await np();
    if (!n.djVoice && !n.djSilence && n.state === "PLAYING") break;
    await api("POST", "/api/next");
    await sleep(1800);
  }
  await sleep(2500);
  // Cancel background poller wait by letting a bit more sample then check volume
  await sleep(3000);
  // Force end poller window early by reading final state
  const finalVol = await vol();
  const finalNp = await np();
  samples.push(sample("overlap-final", finalNp, finalVol));

  // After fresh DJ ends (or is skipped), volume must not remain stuck loud
  // while playing normal music before the deferred shout.
  const musicSamples = samples.filter(
    (s) => !s.dj && !s.silence && s.state === "PLAYING" && s.title
  );
  const loudMusic = musicSamples.filter((s) => s.vol >= baseline + 8);
  const sawSupersedeRestore = musicSamples.some((s) => Math.abs(s.vol - baseline) <= 3);

  // Don't wait full 90s poller
  await Promise.race([poller, sleep(100)]);

  const ok =
    during >= baseline + 3 &&
    loudMusic.length === 0 &&
    (sawSupersedeRestore || Math.abs(finalVol - baseline) <= 3);

  return pass("overlap-request-during-dj", ok, {
    baseline,
    volDuringDj: during,
    finalVol,
    finalTitle: finalNp.title,
    musicSamples: musicSamples.length,
    loudMusicCount: loudMusic.length,
    queueHead: ((await queueList()).tracks || [])
      .slice(0, 5)
      .map((t) => `${t.title}${t.djVoice ? "[DJ]" : ""}`),
  });
}

/**
 * Edge: deferred shout sits >15s (old hard-cap window) then plays with boost.
 */
async function edgeDeferredLongWait() {
  console.log("\n=== EDGE: deferred shout waits >15s then plays ===");
  const baseline = await startFreshRandom(6);
  await waitMusic("defer-warmup", baseline, 90000);
  const track = await searchTrack("September Earth Wind");
  const addRes = await api(
    "POST",
    "/api/queue",
    {
      uri: track.uri,
      name: track.name,
      artist: track.artist,
      requestedBy: "EdgeDefer",
    },
    180000
  );
  console.log("defer add", addRes.absoluteQueuePosition, addRes.queuePosition);
  const q = await queueList();
  console.log(
    "queue head",
    (q.tracks || []).slice(0, 6).map((t, i) => `${i + 1}:${t.title}${t.djVoice ? "[DJ]" : ""}`)
  );

  // Stay on music for 18s — longer than old enqueue hard-cap — without skipping to DJ.
  const waitSamples = [];
  for (let i = 0; i < 72; i++) {
    const [n, v] = await Promise.all([np(), vol()]);
    waitSamples.push(sample("defer-wait", n, v));
    if (n.djVoice) break; // accidental advance
    await sleep(250);
  }
  const waitedMs =
    waitSamples.length > 1
      ? 250 * (waitSamples.length - 1)
      : 0;
  const loudDuringWait = waitSamples.some(
    (s) => !s.dj && !s.silence && s.vol >= baseline + 8
  );

  // Now skip to the deferred DJ
  let sawDj = false;
  let maxDjVol = 0;
  let sawSil = false;
  let musicAfter = null;
  for (let skips = 0; skips < 10 && !musicAfter; skips++) {
    const [n, v] = await Promise.all([np(), vol()]);
    sample("defer-seek", n, v);
    if (n.djVoice && !n.djSilence) {
      sawDj = true;
      maxDjVol = Math.max(maxDjVol, v);
    }
    if (n.djSilence) sawSil = true;
    if (sawDj && sawSil && !n.djVoice && !n.djSilence && n.state === "PLAYING") {
      musicAfter = { title: n.title, vol: v };
      break;
    }
    if (!n.djVoice && !n.djSilence) {
      await api("POST", "/api/next");
      await sleep(1600);
    } else {
      await sleep(POLL_MS);
    }
  }
  // Drain remaining handoff if needed
  const t1 = Date.now();
  while (Date.now() - t1 < 30000 && !musicAfter) {
    const [n, v] = await Promise.all([np(), vol()]);
    sample("defer-handoff", n, v);
    if (n.djVoice && !n.djSilence) {
      sawDj = true;
      maxDjVol = Math.max(maxDjVol, v);
    }
    if (n.djSilence) sawSil = true;
    if (sawDj && (sawSil || true) && !n.djVoice && !n.djSilence && n.state === "PLAYING") {
      // Prefer after silence, but accept restore via left-announce
      if (sawSil || Math.abs(v - baseline) <= 3) {
        musicAfter = { title: n.title, vol: v };
        break;
      }
    }
    await sleep(POLL_MS);
  }

  const ok =
    waitedMs >= 15000 &&
    !loudDuringWait &&
    sawDj &&
    maxDjVol >= baseline + 3 &&
    musicAfter &&
    Math.abs(musicAfter.vol - baseline) <= 3;

  return pass("deferred-long-wait", ok, {
    baseline,
    waitedMs,
    loudDuringWait,
    sawDj,
    maxDjVol,
    sawSil,
    musicAfter,
  });
}

/** Edge: high music volume tier — small bump, full restore. */
async function edgeHighVolumeTier() {
  console.log("\n=== EDGE: high volume tier (~70) ===");
  await clearQueue();
  const baseline = await nudgeVolumeTo(70);
  // expect high tier 4% of remaining: 70 + round(30*0.04)=71
  const expected = baseline + Math.round(((100 - baseline) * 4) / 100);
  const track = await searchTrack("Come On Eileen Dexys");
  const samples = [];
  const addP = api(
    "POST",
    "/api/queue",
    {
      uri: track.uri,
      name: track.name,
      artist: track.artist,
      requestedBy: "EdgeHigh",
    },
    180000
  );
  const poller = (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const [n, v] = await Promise.all([np(), vol()]);
      samples.push(sample("high", n, v));
      if (
        samples.some((s) => s.dj) &&
        samples.some((s) => s.silence) &&
        samples.some(
          (s, i) =>
            i > 0 &&
            !s.dj &&
            !s.silence &&
            s.state === "PLAYING" &&
            /eileen/i.test(s.title || "")
        )
      ) {
        break;
      }
      await sleep(POLL_MS);
    }
  })();
  await addP;
  await poller;
  const maxDj = Math.max(0, ...samples.filter((s) => s.dj).map((s) => s.vol));
  const iDj = samples.findIndex((s) => s.dj);
  const iRest =
    iDj >= 0 ? samples.findIndex((s, i) => i > iDj && s.silence) : -1;
  const after = iRest >= 0 ? iRest : iDj;
  const music = samples.find(
    (s, i) =>
      i > after && after >= 0 && !s.dj && !s.silence && s.state === "PLAYING"
  );
  const ok =
    samples.some((s) => s.dj) &&
    samples.some((s) => s.silence) &&
    maxDj >= baseline &&
    maxDj <= baseline + 6 &&
    music &&
    Math.abs(music.vol - baseline) <= 3;
  return pass("high-volume-tier", ok, {
    baseline,
    expectedAnnounce: expected,
    maxDj,
    musicVol: music?.vol ?? null,
  });
}

/** Edge: two rapid mid-queue requests — both get shouts; volume ends correct. */
async function edgeDoubleRequest() {
  console.log("\n=== EDGE: double rapid mid-queue requests ===");
  const baseline = await startFreshRandom(5);
  await waitMusic("double-warmup", baseline, 90000);
  const a = await searchTrack("September Earth Wind");
  const b = await searchTrack("Billie Jean Michael Jackson");
  console.log("adding first request...");
  await api(
    "POST",
    "/api/queue",
    { uri: a.uri, name: a.name, artist: a.artist, requestedBy: "EdgeA" },
    180000
  );
  console.log("adding second request...");
  await api(
    "POST",
    "/api/queue",
    { uri: b.uri, name: b.name, artist: b.artist, requestedBy: "EdgeB" },
    180000
  );
  const head = ((await queueList()).tracks || []).slice(0, 8);
  console.log(
    "queue",
    head.map((t, i) => `${i + 1}:${t.title}${t.djVoice ? "[DJ]" : ""}`)
  );
  const djCount = head.filter((t) => t.djVoice).length;

  // Walk handoffs: expect volume restore after each
  let handoffs = 0;
  let failures = 0;
  for (let skips = 0; skips < 16 && handoffs < 2; skips++) {
    const [n, v] = await Promise.all([np(), vol()]);
    sample("double", n, v);
    if (n.djVoice && !n.djSilence && v >= baseline + 3) {
      // wait for restore to music
      const t0 = Date.now();
      let restored = false;
      while (Date.now() - t0 < 40000) {
        const [n2, v2] = await Promise.all([np(), vol()]);
        sample("double-h", n2, v2);
        if (!n2.djVoice && !n2.djSilence && n2.state === "PLAYING") {
          if (Math.abs(v2 - baseline) <= 3) restored = true;
          else failures++;
          handoffs++;
          break;
        }
        await sleep(POLL_MS);
      }
      if (!restored) failures++;
      continue;
    }
    if (!n.djVoice && !n.djSilence) {
      await api("POST", "/api/next");
      await sleep(1500);
    } else await sleep(POLL_MS);
  }

  const finalVol = await vol();
  const ok = djCount >= 2 && handoffs >= 1 && failures === 0 && Math.abs(finalVol - baseline) <= 3;
  return pass("double-rapid-requests", ok, {
    baseline,
    djCount,
    handoffs,
    failures,
    finalVol,
  });
}

/** Edge: Never-Ending refill announce after draining upcoming. */
async function edgeRefill() {
  console.log("\n=== EDGE: never-ending refill announce ===");
  // Re-assert Never-Ending so the monitor is armed (also after restarts).
  try {
    await api("POST", "/api/autofill", { enabled: true });
  } catch (e) {
    console.warn("autofill enable:", e.message);
  }
  const af = await api("GET", "/api/autofill");
  console.log("autofill", { enabled: af.enabled, playlists: (af.playlistIds || []).length });

  const baseline = await startFreshRandom(3);
  await waitMusic("refill-warmup", baseline, 90000);

  let sawDjAfterDrain = false;
  let maxDj = 0;
  let sawSil = false;
  let musicVol = null;
  let sawAutofill = false;
  const t0 = Date.now();
  let skips = 0;
  while (Date.now() - t0 < 240000) {
    const [n, v, q] = await Promise.all([np(), vol(), queueList()]);
    const upcoming = (q.tracks || []).length;
    sample(`refill(up=${upcoming})`, n, v);

    // Detect refill DJ: queue grew and a DJ row appeared after we drained.
    if (upcoming >= 4) sawAutofill = true;
    if (n.djVoice && !n.djSilence && (skips >= 2 || sawAutofill)) {
      sawDjAfterDrain = true;
      maxDj = Math.max(maxDj, v);
    }
    if (sawDjAfterDrain && n.djSilence) sawSil = true;
    if (
      sawDjAfterDrain &&
      (sawSil || maxDj >= baseline + 3) &&
      !n.djVoice &&
      !n.djSilence &&
      n.state === "PLAYING" &&
      Math.abs(v - baseline) <= 3
    ) {
      musicVol = v;
      if (sawSil || sawAutofill) break;
    }

    // After autofill tops up, stop draining — when refill DJ is next, play it.
    if (sawAutofill && !sawDjAfterDrain && !n.djVoice) {
      const head = (q.tracks || [])[0];
      if (head?.djVoice) {
        try {
          await api("POST", "/api/next");
        } catch {
          /* ignore */
        }
        await sleep(1500);
        continue;
      }
      await sleep(1000);
      continue;
    }

    // Drain until 0–1 upcoming, then wait for autofill.
    if (!n.djVoice && !n.djSilence && upcoming > 1 && skips < 20 && !sawAutofill) {
      skips++;
      try {
        await api("POST", "/api/next");
      } catch {
        /* ignore */
      }
      await sleep(1200);
      continue;
    }
    if (!n.djVoice && !n.djSilence && upcoming <= 1 && !sawDjAfterDrain && !sawAutofill) {
      if (skips < 22 && upcoming === 1) {
        skips++;
        try {
          await api("POST", "/api/next");
        } catch {
          /* ignore */
        }
        await sleep(1500);
        continue;
      }
      await sleep(1000);
      continue;
    }
    await sleep(POLL_MS);
  }

  let logHint = false;
  try {
    const text = fs.readFileSync(
      new URL("../data/server-out.log", import.meta.url),
      "utf8"
    );
    const lines = text.split(/\r?\n/).slice(-120);
    logHint = lines.some((l) => /inserting refill announce|autofill.*topped up/i.test(l));
    console.log(
      "log:",
      lines
        .filter((l) => /dj-voice|autofill|volume|refill|superseded|pre-boost/i.test(l))
        .slice(-25)
        .join("\n")
    );
  } catch (e) {
    console.warn(e.message);
  }

  const ok =
    (sawDjAfterDrain || logHint) &&
    maxDj >= baseline + 3 &&
    musicVol != null &&
    Math.abs(musicVol - baseline) <= 3;

  return pass("refill-announce", ok, {
    baseline,
    sawDjAfterDrain,
    sawAutofill,
    maxDj,
    sawSil,
    musicVol,
    logHint,
  });
}

/** Edge: media base + silence reachable (Docker/local Sonos fetch path). */
async function edgeMedia() {
  console.log("\n=== EDGE: media-base + silence HTTP ===");
  const health = await api("GET", "/api/health");
  const mb = await api("GET", "/api/media-base");
  const silenceUrl = `${mb.url}/media/tts/silence-2s.mp3`;
  const rampUrl = `${mb.url}/media/tts/silence-ramp-2s.mp3`;
  let silenceCode = 0;
  let rampCode = 0;
  try {
    const [rSil, rRamp] = await Promise.all([
      fetch(silenceUrl, { method: "HEAD" }),
      fetch(rampUrl, { method: "HEAD" }),
    ]);
    silenceCode = rSil.status;
    rampCode = rRamp.status;
  } catch (e) {
    return pass("media-silence", false, {
      error: e.message,
      silenceUrl,
      rampUrl,
    });
  }
  // Local LAN IP in media base should not be Unraid-only when on Windows
  const url = String(mb.url || "");
  const looksReachable = silenceCode === 200 && rampCode === 200;
  return pass("media-silence", looksReachable, {
    version: health.version,
    mediaBase: url,
    silenceUrl,
    silenceCode,
    rampUrl,
    rampCode,
  });
}

async function main() {
  const health = await api("GET", "/api/health");
  const settings = await api("GET", "/api/settings");
  console.log("health", health);
  console.log("dj", {
    voice: settings.djVoiceEnabled,
    shout: settings.djShoutEnabled,
    mode: settings.djShoutMode,
    every: settings.djShoutEveryN,
    silence: settings.djSilenceSec,
  });

  const run = async (name, fn) => {
    if (WHICH !== "all" && WHICH !== name) return;
    try {
      await fn();
    } catch (err) {
      pass(name, false, { error: String(err.message || err) });
    }
  };

  await run("media", edgeMedia);
  await run("skip-dj", edgeSkipDuringDj);
  await run("skip-sil", edgeSkipDuringSilence);
  await run("overlap", edgeOverlapDuringDj);
  await run("defer", edgeDeferredLongWait);
  await run("high", edgeHighVolumeTier);
  await run("double", edgeDoubleRequest);
  await run("refill", edgeRefill);

  const out = new URL("../tmp-smoke-volume-edges.json", import.meta.url);
  fs.writeFileSync(out, JSON.stringify({ reports: REPORTS, log: LOG }, null, 2));
  console.log("\n========== EDGE REPORT ==========");
  for (const r of REPORTS) console.log(JSON.stringify(r));
  console.log(`wrote ${out.pathname}`);
  const failed = REPORTS.filter((r) => !r.pass);
  if (failed.length) {
    console.error(`FAIL: ${failed.map((f) => f.label).join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("ALL EDGE PASS");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
