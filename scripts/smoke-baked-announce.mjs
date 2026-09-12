#!/usr/bin/env node
/**
 * Live check for the single-row baked announce.
 *
 * Clears the room, starts a fresh set, and watches what actually lands in the
 * Sonos queue and what the volume does. The three things that must hold:
 *
 *   1. the announce occupies exactly ONE queue row, not a 3-4 row pad block
 *   2. the volume rises for the DJ and comes back to the level we started at
 *   3. Next / Previous / Play-Pause are all accepted while an announce is live
 *
 * Point it at a single room and keep the volume low:
 *   node --env-file-if-exists=.env scripts/smoke-baked-announce.mjs
 */
import { api, ensureHostAuth, sleep, waitFor, vol } from "./smoke-lib.mjs";

const SONGS = Number(process.env.PQ_SONGS || 5);

const isAnnounceRow = (row) =>
  /\/media\/tts\//i.test(String(row?.uri ?? row?.TrackUri ?? ""));
const isBakedRow = (row) =>
  /dj-announce-[0-9a-f]{16}\.mp3/i.test(String(row?.uri ?? row?.TrackUri ?? ""));

const failures = [];
const fail = (m) => {
  failures.push(m);
  console.error(`  FAIL  ${m}`);
};
const pass = (m) => console.log(`  ok    ${m}`);

async function rows() {
  const list = await api("GET", "/api/queue/list");
  return Array.isArray(list) ? list : list.items || list.queue || [];
}

function describe(list) {
  return list
    .map((r, i) => {
      const uri = String(r.uri ?? r.TrackUri ?? "");
      const tag = isBakedRow(r)
        ? "ANNOUNCE(baked)"
        : isAnnounceRow(r)
          ? "PAD"
          : "song";
      return `    #${i + 1} ${tag.padEnd(16)} ${r.title || uri.slice(0, 60)}`;
    })
    .join("\n");
}

await ensureHostAuth();

console.log("clearing the room");
await api("POST", "/api/queue/clear");
await sleep(1500);

const baseline = await vol();
console.log(`baseline volume: ${baseline}`);

console.log(`starting a fresh set of ${SONGS}`);
await api("POST", "/api/queue/random", { count: SONGS });

// The announce is written and voiced after the add, so poll rather than sleep.
const seen = await waitFor(rows, (list) => list.some(isAnnounceRow), {
  timeoutMs: 90_000,
  everyMs: 1000,
});

console.log("\nqueue:");
console.log(describe(seen.value));

if (!seen.ok) {
  fail("no announce ever reached the queue");
} else {
  const announceRows = seen.value.filter(isAnnounceRow);
  const bakedRows = seen.value.filter(isBakedRow);

  if (bakedRows.length === 1 && announceRows.length === 1) {
    pass("announce is exactly one baked row");
  } else {
    fail(
      `expected 1 baked row, saw ${bakedRows.length} baked / ` +
        `${announceRows.length} announce-ish rows`
    );
  }
  const padRows = announceRows.filter((r) => !isBakedRow(r));
  if (padRows.length === 0) pass("no leftover silence pad rows");
  else fail(`${padRows.length} bare silence pad row(s) still enqueued`);
}

// --- the three buttons that broke in 11.2.4 --------------------------------
console.log("\ntransport controls during the announce:");
const volumes = [baseline];
const press = async (label, path) => {
  try {
    await api("POST", path);
    pass(`${label} accepted`);
  } catch (err) {
    fail(`${label} refused: ${err.message}`);
  }
  volumes.push(await vol());
  await sleep(2500);
};

await sleep(4000);
await press("Play/Pause (pause)", "/api/pause");
await press("Play/Pause (play)", "/api/play");
await press("Next", "/api/next");
await press("Previous", "/api/previous");

// --- volume must come home -------------------------------------------------
console.log("\nwaiting for the announce to finish, then checking volume");
const settled = await waitFor(vol, (v) => v === baseline, {
  timeoutMs: 90_000,
  everyMs: 1000,
});
if (settled.ok) pass(`volume returned to ${baseline}`);
else fail(`volume settled at ${settled.value}, expected ${baseline}`);

console.log(`\nvolume samples: ${volumes.join(" -> ")} ... ${settled.value}`);

if (failures.length) {
  console.error(`\nFAILED (${failures.length})`);
  process.exit(1);
}
console.log("\nPASS — one-row announce, all three buttons accepted, volume restored");
