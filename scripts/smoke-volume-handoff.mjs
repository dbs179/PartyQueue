#!/usr/bin/env node
/**
 * Live Sonos smoke: pre-silence → boost → DJ → post-silence → restore → music
 * Usage: node scripts/smoke-volume-handoff.mjs [empty|mid|batch|refill|all]
 */
import fs from "node:fs";

const BASE = process.env.PQ_BASE || "http://127.0.0.1:8088";
const SCENARIO = (process.argv[2] || "all").toLowerCase();
const BASELINE = Math.max(
  0,
  Math.min(100, Math.round(Number(process.env.PQ_BASELINE) || 20))
);
const POLL_MS = 250;
const LOG = [];

function ts() {
  return new Date().toISOString().slice(11, 23);
}

async function api(method, path, body, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = {};
    const m = String(method || "").toUpperCase();
    if (m === "POST" || m === "DELETE" || m === "PUT" || m === "PATCH") {
      try {
        headers.Origin = new URL(BASE).origin;
      } catch {
        /* ignore */
      }
    }
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
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
      const err = new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      err.json = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function vol() {
  const j = await api("GET", "/api/volume");
  return Number(j.volume);
}

async function np() {
  return api("GET", "/api/nowplaying");
}

async function queueList() {
  return api("GET", "/api/queue/list");
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function nudgeVolumeTo(target) {
  let v = await vol();
  let guard = 0;
  while (Math.abs(v - target) > 1 && guard++ < 40) {
    if (v < target) await api("POST", `/api/volume/up?step=${Math.min(5, target - v)}`);
    else await api("POST", `/api/volume/down?step=${Math.min(5, v - target)}`);
    await sleep(300);
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
    artist: n?.artist || null,
    state: n?.state || null,
    // NP marks silence pads as djVoice too — real TTS is djVoice && !djSilence.
    dj: !!(n?.djVoice && !n?.djSilence),
    silence: !!n?.djSilence,
    uri: String(n?.uri || "").slice(0, 80),
  };
  row.ramp = row.silence && /silence-ramp-/i.test(row.uri);
  row.restore = row.silence && !row.ramp;
  LOG.push(row);
  console.log(
    `${row.t} [${label}] vol=${row.vol} dj=${row.dj} sil=${row.silence} state=${row.state} | ${row.title || "-"}`
  );
  return row;
}

async function pollUntil(label, { maxMs, everyMs = POLL_MS, pred }) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < maxMs) {
    const [n, v] = await Promise.all([np(), vol()]);
    last = sample(label, n, v);
    if (pred(last, n, v)) return { ok: true, last, n, v };
    await sleep(everyMs);
  }
  return { ok: false, last };
}

function analyze(label, samples, baseline) {
  const boostExpectedMin = baseline + 3; // any meaningful bump
  const sawBoost = samples.some(
    (s) => s.vol >= boostExpectedMin && (s.dj || s.silence)
  );
  const maxDuringDj = Math.max(0, ...samples.filter((s) => s.dj).map((s) => s.vol));
  const sawDj = samples.some((s) => s.dj);
  const sawSilence = samples.some((s) => s.silence);

  // Order: pre-silence → boost → DJ → post-silence → exact baseline → music.
  const idx = (pred) => samples.findIndex(pred);
  const iBoost = idx((s) => s.vol >= boostExpectedMin);
  const iDj = idx((s) => s.dj);
  const iRamp = idx((s) => s.ramp);
  const iRestore = samples.findIndex((s, i) => i > iDj && s.restore);
  const iMusic = samples.findIndex(
    (s, i) =>
      i > iDj &&
      iDj >= 0 &&
      !s.dj &&
      !s.silence &&
      s.title &&
      s.state === "PLAYING"
  );
  const firstMusic = iMusic >= 0 ? samples[iMusic] : null;
  const restoredOnMusic =
    iMusic >= 0 &&
    samples[iMusic].vol === baseline;
  const restoredDuringSilence =
    iRestore >= 0 &&
    samples
      .slice(iRestore, iMusic >= 0 ? iMusic : undefined)
      .some((s) => s.restore && s.vol === baseline);
  // Boost should land on ramp silence or at DJ start — not deep into a song.
  const boostOnPadOrDj =
    iBoost < 0 ||
    (iBoost >= 0 &&
      (samples[iBoost].silence ||
        samples[iBoost].dj ||
        (iDj >= 0 && iBoost <= iDj + 2)));

  const orderOk =
    iRamp >= 0 &&
    iDj >= 0 &&
    iRestore >= 0 &&
    iMusic >= 0 &&
    iRamp < iDj &&
    iDj < iRestore &&
    iRestore < iMusic &&
    boostOnPadOrDj;

  const report = {
    label,
    baseline,
    sawDj,
    sawSilence,
    sawBoost,
    maxDuringDj,
    restoredOnMusic,
    restoredDuringSilence,
    firstMusicTitle: firstMusic?.title || null,
    firstMusicVol: firstMusic?.vol ?? null,
    orderOk,
    indices: { iBoost, iRamp, iDj, iRestore, iMusic },
    pass:
      sawDj &&
      sawSilence &&
      sawBoost &&
      restoredDuringSilence &&
      restoredOnMusic &&
      orderOk,
  };
  return report;
}

async function searchTrack(q) {
  const j = await api("GET", `/api/search?q=${encodeURIComponent(q)}`);
  const list = Array.isArray(j) ? j : j.results || j.tracks || [];
  const t = list[0];
  if (!t?.uri) throw new Error(`No search hit for ${q}: ${JSON.stringify(j).slice(0, 180)}`);
  return {
    uri: t.uri,
    name: t.name || t.title,
    artist: t.artist || t.artists || "Unknown",
  };
}

async function clearQueue() {
  try {
    await api("POST", "/api/queue/clear");
  } catch (e) {
    console.warn("clear:", e.message);
  }
  await sleep(800);
}

async function scenarioEmpty() {
  console.log("\n=== SCENARIO A: empty queue request ===");
  await clearQueue();
  const baseline = await nudgeVolumeTo(BASELINE);
  console.log(`baseline volume=${baseline} (expect announce ~${baseline + Math.round(((100 - baseline) * 20) / 100)})`);
  const track = await searchTrack("Come On Eileen Dexys");
  const samples = [];
  const addPromise = api("POST", "/api/queue", {
    uri: track.uri,
    name: track.name || track.title,
    artist: track.artist,
    requestedBy: "SmokeTest",
  });
  // Poll while add completes + announce plays
  const poller = (async () => {
    const started = Date.now();
    while (Date.now() - started < 90000) {
      const [n, v] = await Promise.all([np(), vol()]);
      samples.push(sample("empty", n, v));
      if (
        samples.filter((s) => s.dj).length >= 1 &&
        samples.filter((s) => s.silence).length >= 1 &&
        samples.some(
          (s) =>
            !s.dj &&
            !s.silence &&
            s.state === "PLAYING" &&
            s.title &&
            /eileen|goodbye|smoke/i.test(s.title + (s.artist || ""))
        )
      ) {
        // a few more samples after music starts
        for (let i = 0; i < 8; i++) {
          await sleep(POLL_MS);
          const [n2, v2] = await Promise.all([np(), vol()]);
          samples.push(sample("empty", n2, v2));
        }
        break;
      }
      await sleep(POLL_MS);
    }
  })();
  const addRes = await addPromise;
  console.log("add result:", JSON.stringify({ ok: addRes.ok, queueWasEmpty: addRes.queueWasEmpty, started: addRes.started }));
  await poller;
  return analyze("empty", samples, baseline);
}

async function scenarioMidRandom() {
  console.log("\n=== SCENARIO B: request mid-Random queue ===");
  await clearQueue();
  const baseline = await nudgeVolumeTo(BASELINE);
  console.log(`baseline volume=${baseline}`);

  const randomRes = await api(
    "POST",
    "/api/queue/random",
    { count: 5 },
    180000
  );
  console.log(
    "random:",
    JSON.stringify({
      added: randomRes.added,
      announced: randomRes.announced,
      started: randomRes.started,
    })
  );

  // Wait until first music is playing (after any fresh-set DJ)
  await pollUntil("mid-warmup", {
    maxMs: 90000,
    pred: (s) => s.state === "PLAYING" && !s.dj && !s.silence && !!s.title,
  });
  // Let music settle a few seconds
  await sleep(3000);
  const baseline2 = await vol();
  console.log(`mid-queue music volume=${baseline2}`);

  const track = await searchTrack("September Earth Wind");
  console.log("adding mid-queue request (awaits DJ insert)...");
  const addRes = await api(
    "POST",
    "/api/queue",
    {
      uri: track.uri,
      name: track.name || track.title,
      artist: track.artist,
      requestedBy: "SmokeTest",
    },
    180000
  );
  console.log(
    "mid add:",
    JSON.stringify({
      ok: addRes.ok,
      queueWasEmpty: addRes.queueWasEmpty,
      absoluteQueuePosition: addRes.absoluteQueuePosition,
      queuePosition: addRes.queuePosition,
    })
  );

  // Confirm DJ+silence sit ahead of the request before skipping.
  const q = await queueList();
  const tracks = q.tracks || [];
  console.log(
    "queue head:",
    tracks.slice(0, 6).map((t, i) => `${i + 1}:${t.title || t.name}${t.djVoice ? "[DJ]" : ""}${t.djSilence ? "[SIL]" : ""}`)
  );

  const samples = [];
  let skips = 0;
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const [n, v] = await Promise.all([np(), vol()]);
    samples.push(sample("mid", n, v));
    if (
      samples.some((s) => s.dj) &&
      samples.some((s) => s.silence) &&
      samples.some((s) => s.silence) &&
      samples.some(
        (s, i) =>
          i > samples.findIndex((x) => x.silence) &&
          !s.dj &&
          !s.silence &&
          s.state === "PLAYING" &&
          s.title
      )
    ) {
      for (let i = 0; i < 8; i++) {
        await sleep(POLL_MS);
        const [n2, v2] = await Promise.all([np(), vol()]);
        samples.push(sample("mid", n2, v2));
      }
      break;
    }
    // Only skip after shout is queued; stop skipping once DJ starts.
    if (
      !samples.some((s) => s.dj) &&
      n?.state === "PLAYING" &&
      !n.djVoice &&
      !n.djSilence &&
      skips < 8
    ) {
      skips++;
      try {
        await api("POST", "/api/next");
      } catch {
        /* ignore */
      }
      await sleep(1800);
      continue;
    }
    await sleep(POLL_MS);
  }
  return analyze("mid", samples, baseline2);
}

async function scenarioBatch() {
  console.log("\n=== SCENARIO C: new Random batch / refill announce ===");
  await clearQueue();
  const baseline = await nudgeVolumeTo(BASELINE);

  // Fresh random set — this IS a new batch with startPlayback announce
  const randomRes = await api(
    "POST",
    "/api/queue/random",
    { count: 4 },
    180000
  );
  console.log(
    "batch random:",
    JSON.stringify({
      added: randomRes.added,
      announced: randomRes.announced,
      started: randomRes.started,
      similarAdded: randomRes.similarAdded,
    })
  );

  const samples = [];
  const started = Date.now();
  while (Date.now() - started < 90000) {
    const [n, v] = await Promise.all([np(), vol()]);
    samples.push(sample("batch", n, v));
    if (
      samples.some((s) => s.dj) &&
      samples.some((s) => s.silence) &&
      samples.some((s) => !s.dj && !s.silence && s.state === "PLAYING" && s.title)
    ) {
      for (let i = 0; i < 8; i++) {
        await sleep(POLL_MS);
        const [n2, v2] = await Promise.all([np(), vol()]);
        samples.push(sample("batch", n2, v2));
      }
      break;
    }
    await sleep(POLL_MS);
  }
  return analyze("batch-fresh", samples, baseline);
}

async function scenarioRefill() {
  console.log("\n=== SCENARIO D: Never-Ending refill announce (mid-party batch) ===");
  // Self-contained: arm autofill, seed a short set, drain until top-up, then
  // land on the queued refill ramp→DJ→music handoff (do not blind-skip past it).
  try {
    await api("POST", "/api/autofill", { enabled: true });
  } catch (e) {
    console.warn("autofill enable:", e.message);
  }
  const af = await api("GET", "/api/autofill");
  console.log("autofill", {
    enabled: af.enabled,
    playlists: (af.playlistIds || []).length,
  });

  await clearQueue();
  const baseline = await nudgeVolumeTo(BASELINE);
  const randomRes = await api(
    "POST",
    "/api/queue/random",
    { count: 3 },
    180000
  );
  console.log(
    "refill seed:",
    JSON.stringify({
      added: randomRes.added,
      announced: randomRes.announced,
      started: randomRes.started,
    })
  );

  // Reach first music so drain skips are meaningful.
  await pollUntil("refill-warmup", {
    maxMs: 90000,
    pred: (s) => s.state === "PLAYING" && !s.dj && !s.silence && !!s.title,
  });

  const samples = [];
  let skips = 0;
  const started = Date.now();
  let sawRefillLogHint = false;
  let sawAutofill = false;
  let handoffAt = -1;
  const minUpcomingAfterFill = 3;

  while (Date.now() - started < 240000) {
    const [n, v, q] = await Promise.all([np(), vol(), queueList()]);
    const tracks = Array.isArray(q?.tracks) ? q.tracks : Array.isArray(q) ? q : [];
    const upcoming = tracks.length;
    const head = tracks[0] || null;
    const headIsPad = !!(head?.djVoice || head?.djSilence);
    samples.push(sample(`refill(up=${upcoming})`, n, v));

    if (upcoming >= minUpcomingAfterFill) sawAutofill = true;

    const realDj = !!(n?.djVoice && !n?.djSilence);
    const onSil = !!n?.djSilence;

    // Handoff window: ramp/DJ after we have drained (or after autofill topped up).
    if (
      handoffAt < 0 &&
      (skips >= 1 || sawAutofill) &&
      (onSil || realDj)
    ) {
      handoffAt = samples.length - 1;
      console.log(
        `refill handoff detected at sample ${handoffAt} (skips=${skips}, autofill=${sawAutofill}, sil=${onSil}, dj=${realDj})`
      );
    }

    if (handoffAt >= 0) {
      const after = samples.slice(handoffAt);
      const sawHandoffDj = after.some((s) => s.dj);
      const sawHandoffSil = after.some((s) => s.silence);
      const iDj = after.findIndex((s) => s.dj);
      const musicAfter = after.some(
        (s, i) =>
          i > iDj &&
          iDj >= 0 &&
          !s.dj &&
          !s.silence &&
          s.state === "PLAYING" &&
          s.title
      );
      if (sawHandoffDj && sawHandoffSil && musicAfter) {
        for (let i = 0; i < 8; i++) {
          await sleep(POLL_MS);
          const [n2, v2] = await Promise.all([np(), vol()]);
          samples.push(sample("refill", n2, v2));
        }
        break;
      }
      // Already on pads — just keep sampling through the handoff.
      await sleep(POLL_MS);
      continue;
    }

    // After autofill: stop draining music. Skip once onto the refill pad if it
    // is next in queue; otherwise wait for the boundary to arrive naturally.
    if (sawAutofill && !realDj && !onSil) {
      if (headIsPad) {
        console.log(
          `refill: queue head is announce pad — next() onto it (${head?.title || "?"})`
        );
        try {
          await api("POST", "/api/next");
        } catch {
          /* ignore */
        }
        await sleep(1600);
        continue;
      }
      // Pad may be deeper than head=0 if Sonos still has current track as "now";
      // peek a few upcoming rows for a DJ/silence marker and advance carefully.
      const padIdx = tracks.findIndex((t) => t?.djVoice || t?.djSilence);
      if (padIdx >= 0 && padIdx <= 2 && skips < 40) {
        skips++;
        try {
          await api("POST", "/api/next");
        } catch {
          /* ignore */
        }
        await sleep(1600);
        continue;
      }
      await sleep(1000);
      continue;
    }

    // Pre-autofill: drain until 0–1 upcoming so Never-Ending tops up.
    if (!n.djVoice && !n.djSilence && upcoming > 1 && skips < 24 && !sawAutofill) {
      skips++;
      try {
        await api("POST", "/api/next");
      } catch {
        /* ignore */
      }
      await sleep(1400);
      continue;
    }
    if (
      !n.djVoice &&
      !n.djSilence &&
      upcoming <= 1 &&
      !sawAutofill &&
      skips < 28
    ) {
      // One more next when a single track remains, then wait for top-up.
      if (upcoming === 1) {
        skips++;
        try {
          await api("POST", "/api/next");
        } catch {
          /* ignore */
        }
        await sleep(1600);
        continue;
      }
      await sleep(1000);
      continue;
    }

    await sleep(POLL_MS);
  }

  // Read server log for refill evidence
  try {
    const logPath = new URL("../data/server-out.log", import.meta.url);
    const text = fs.readFileSync(logPath, "utf8");
    const lines = text.split(/\r?\n/).slice(-120);
    sawRefillLogHint = lines.some((l) =>
      /inserting refill announce|autofill.*topped up|refill announce/i.test(l)
    );
    console.log("recent log hints:");
    for (const l of lines
      .filter((x) => /dj-voice|autofill|volume|silence|refill/i.test(x))
      .slice(-25)) {
      console.log("  ", l);
    }
  } catch (e) {
    console.warn("log read:", e.message);
  }

  // Score only the handoff window so pre-drain music cannot poison orderOk.
  const window =
    handoffAt >= 0 ? samples.slice(handoffAt) : samples.slice(-40);
  const report = analyze("refill", window, baseline);
  report.sawRefillLogHint = sawRefillLogHint;
  report.sawAutofill = sawAutofill;
  report.handoffAt = handoffAt;
  report.totalSamples = samples.length;
  return report;
}

async function main() {
  const health = await api("GET", "/api/health");
  console.log("health", health);
  const settings = await api("GET", "/api/settings");
  console.log("djVoice", settings.djVoiceEnabled, "shout", settings.djShoutEnabled, "mode", settings.djShoutMode, "every", settings.djShoutEveryN, "silence", settings.djSilenceSec);

  const reports = [];
  if (SCENARIO === "all" || SCENARIO === "empty") reports.push(await scenarioEmpty());
  if (SCENARIO === "all" || SCENARIO === "mid") reports.push(await scenarioMidRandom());
  if (SCENARIO === "all" || SCENARIO === "batch") reports.push(await scenarioBatch());
  if (SCENARIO === "all" || SCENARIO === "refill") reports.push(await scenarioRefill());

  console.log("\n========== VOLUME HANDOFF REPORT ==========");
  for (const r of reports) {
    console.log(JSON.stringify(r, null, 2));
  }
  const failed = reports.filter((r) => !r.pass);
  const out = new URL("../tmp-smoke-volume-report.json", import.meta.url);
  fs.writeFileSync(out, JSON.stringify({ reports, log: LOG }, null, 2));
  console.log(`wrote ${out.pathname}`);
  if (failed.length) {
    console.error(`FAIL: ${failed.map((f) => f.label).join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("ALL PASS");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
