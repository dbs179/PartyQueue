#!/usr/bin/env node
/**
 * Live check of the write-behind add path (14.0.0+) against a real speaker.
 *
 * Everything in test/async-adds.test.js runs against an in-memory fake, so this
 * is the only thing that proves the drainer actually places a song on Sonos,
 * that the true-up matches real GetQueue rows, and that the guest is answered
 * before any of it happens.
 *
 *   PQ_BASE=http://10.10.1.30:8088 node scripts/smoke-async-add.mjs
 *   PQ_SMOKE_ROOM=Office ...
 *
 * Restores the target room and volume it found, and clears the song it added.
 */
import {
  api,
  ensureHostAuth,
  searchTrack,
  sleep,
  vol,
  nudgeVolumeTo,
  queueTracks,
  BASE,
} from "./smoke-lib.mjs";

const ROOM = process.env.PQ_SMOKE_ROOM || "Office";
const QUERY = process.env.PQ_SMOKE_QUERY || "Never Gonna Give You Up Rick Astley";
const GUEST = process.env.PQ_SMOKE_GUEST || "Smoke Test";
const FORCE = process.env.PQ_SMOKE_FORCE === "1";
const TEST_VOLUME = Math.max(0, Math.min(30, Number(process.env.PQ_SMOKE_VOLUME) || 8));
// The whole point of write-behind: the phone is answered without waiting for
// the speaker. Anything close to a second means we are still blocking on Sonos.
const ACK_BUDGET_MS = 1500;
// Must outlast the drainer's own retry ladder (3+6+12+24+48s across 5 attempts)
// or a slow-but-working placement gets reported as a failure.
const PLACE_BUDGET_MS = 150_000;
// /api/nowplaying is cached for only 1s, so polling any faster than this forces
// a fresh SOAP read on every pass and stops the test resembling real use.
const POLL_MS = 2000;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// Sonos hands queue rows back under its own scheme
// (x-sonos-spotify:spotify%3atrack%3a<id>...), not the spotify:track:<id> URI
// we sent, so rows must be matched on the Spotify id the way add-trueup does.
function spotifyIdOf(value) {
  const m = /spotify(?:%3a|:)track(?:%3a|:)([A-Za-z0-9]+)/i.exec(String(value || ""));
  return m ? m[1] : "";
}

function sameTrack(row, wantId) {
  if (!wantId) return false;
  return row?.id === wantId || spotifyIdOf(row?.uri) === wantId;
}

async function listRows() {
  const payload = await api("GET", "/api/queue/list");
  return { rows: queueTracks(payload), stale: !!payload?.stale };
}

/**
 * Adding to an empty queue starts playback, and getQueueList() hides the
 * currently playing song from "upcoming" the way the Sonos app does. So the
 * song having left the queue list is only good news if it is what is playing.
 */
async function nowPlaying() {
  try {
    const np = await api("GET", "/api/nowplaying");
    return {
      id: np?.id || spotifyIdOf(np?.uri || np?.trackUri),
      title: np?.title || np?.name || "",
      state: np?.state,
    };
  } catch (err) {
    return { id: "", title: "", state: `read failed: ${err.message}` };
  }
}

let restore = null;
// Cleanup empties the queue, so it may only do that if we proved the queue was
// empty before we touched it. Running this during a party must never be the
// thing that deletes everyone's songs.
let mayClearQueue = false;

async function main() {
  console.log(`PartyQueue write-behind smoke — ${BASE}, room "${ROOM}"`);
  await ensureHostAuth();

  const health = await api("GET", "/api/health");
  console.log(`version ${health.version}`);

  const live = await listRows();
  const playing = await nowPlaying();
  if (!FORCE && (live.rows.length || playing.state === "PLAYING")) {
    throw new Error(
      `the party looks live (${live.rows.length} queued, transport ${playing.state}); ` +
        `this test changes the target room and empties the queue. ` +
        `Set PQ_SMOKE_FORCE=1 only if you are sure.`
    );
  }

  const groups = await api("GET", "/api/groups");
  const home = groups.groups.find((g) => g.members.includes(ROOM));
  if (!home) throw new Error(`${ROOM} is not in the current topology`);
  if (home.members.length > 1) {
    throw new Error(
      `${ROOM} is grouped with ${home.members.join(", ")}; isolate it first ` +
        `(node scripts/smoke-office-setup.mjs isolate)`
    );
  }

  restore = { targetRoom: groups.targetRoom, volume: null };
  console.log(`saving target room "${restore.targetRoom}"`);

  await api("POST", "/api/groups/select", { room: ROOM });
  await sleep(1500);
  restore.volume = await vol();
  console.log(`${ROOM} volume ${restore.volume} -> ${TEST_VOLUME}`);
  await nudgeVolumeTo(TEST_VOLUME);

  // The queue belongs to the coordinator, so it has to be re-checked now that
  // the target room has changed - the empty queue we saw was another room's.
  const before = await listRows();
  console.log(`queue before: ${before.rows.length} row(s), stale=${before.stale}`);
  if (before.rows.length && !FORCE) {
    throw new Error(`${ROOM} already has ${before.rows.length} song(s) queued; not touching them`);
  }
  mayClearQueue = true;

  const track = await searchTrack(QUERY);
  if (!track?.uri) throw new Error(`no Spotify result for "${QUERY}"`);
  const trackId = spotifyIdOf(track.uri);
  if (!trackId) throw new Error(`not a Spotify track uri: ${track.uri}`);
  console.log(`adding "${track.name}" — ${track.artist} (${trackId})`);

  // 1. The guest is answered immediately.
  const started = Date.now();
  const ack = await api("POST", "/api/queue", {
    uri: track.uri,
    name: track.name,
    artist: track.artist,
    requestedBy: GUEST,
    requestedByUser: GUEST,
  });
  const ackMs = Date.now() - started;

  check("ack is fast", ackMs < ACK_BUDGET_MS, `${ackMs}ms (budget ${ACK_BUDGET_MS}ms)`);
  check("ack reports pending", ack?.pending === true, JSON.stringify(ack));
  check("ack carries a handle", !!ack?.pendingId, ack?.pendingId || "missing");
  check(
    "ack carries no queue position",
    ack?.queuePosition === undefined,
    `queuePosition=${ack?.queuePosition}`
  );

  // 2. The guest sees the song straight away, marked as still landing.
  const immediately = await listRows();
  const pendingRow = immediately.rows.find((r) => sameTrack(r, trackId));
  check(
    "song is visible to the guest right away",
    !!pendingRow,
    pendingRow ? `pending=${pendingRow.pending}` : "not in the list"
  );

  // 3. The drainer puts it on the real speaker.
  const placeStart = Date.now();
  let placed = null;
  let placeMs = 0;
  let lastSeen = "";
  while (Date.now() - placeStart < PLACE_BUDGET_MS) {
    const { rows, stale } = await listRows();
    const copies = rows.filter((r) => sameTrack(r, trackId));

    const failed = copies.find((r) => r.failed);
    if (failed) {
      placed = { how: "failed", copies };
      break;
    }
    const confirmed = copies.find((r) => !r.pending && !r.failed);
    if (confirmed) {
      placeMs = Date.now() - placeStart;
      placed = { how: "queued", copies };
      break;
    }

    // Only worth a transport read once the queue has stopped explaining things:
    // an upcoming row already answers the question without touching Sonos.
    const np = await nowPlaying();
    lastSeen =
      `queue=${rows.length} stale=${stale} copies=${copies.length} ` +
      `nowplaying=${np.state} "${np.title}"`;
    if (np.id && np.id === trackId) {
      placeMs = Date.now() - placeStart;
      placed = { how: "playing", copies };
      break;
    }
    await sleep(POLL_MS);
  }

  if (!placed) {
    check("song reaches the speaker", false, `gave up after ${PLACE_BUDGET_MS}ms — ${lastSeen}`);
  } else if (placed.how === "failed") {
    check("song reaches the speaker", false, "drainer gave up (row shows Couldn't add)");
  } else {
    check(
      "song reaches the speaker",
      true,
      `${placeMs}ms after the ack, ${placed.how === "playing" ? "now playing" : "in the queue"}`
    );
    // Only meaningful while it is still upcoming; a playing song is not a row.
    if (placed.how === "queued") {
      check(
        "exactly one copy in the queue",
        placed.copies.length === 1,
        `${placed.copies.length} copies`
      );
    }
  }

  // 4. The song is accounted for somewhere the guest can see it - either still
  // upcoming or playing. A guest who watches their song vanish will just add it
  // again, which is the duplicate the outbox exists to prevent.
  const after = await listRows();
  const afterNp = await nowPlaying();
  const row = after.rows.find((r) => sameTrack(r, trackId));
  check(
    "song stays visible through the handover",
    !!row || afterNp.id === trackId,
    row ? `upcoming, pending=${row.pending}` : `nowplaying="${afterNp.title}" stale=${after.stale}`
  );

  // 5. Give the true-up a chance to run. Counting upcoming rows alone would
  // pass on zero, which is the failure it is supposed to catch - so count the
  // playing song too and insist on exactly one copy.
  console.log("waiting 50s for a queue-maintenance tick (true-up)...");
  await sleep(50_000);
  const settled = await listRows();
  const settledNp = await nowPlaying();
  const upcoming = settled.rows.filter((r) => sameTrack(r, trackId)).length;
  const total = upcoming + (settledNp.id === trackId ? 1 : 0);
  check(
    "exactly one copy of the song exists after reconciliation",
    total === 1,
    `${total} copies (${upcoming} upcoming, nowplaying="${settledNp.title}")`
  );
}

async function cleanup() {
  if (!restore) return;
  console.log("\ncleaning up...");
  try {
    await api("POST", "/api/pause");
  } catch {
    /* already stopped */
  }
  if (mayClearQueue) {
    try {
      await api("POST", "/api/queue/clear");
      console.log("queue cleared");
    } catch (err) {
      console.warn(`could not clear the queue: ${err.message}`);
    }
  } else {
    console.log("leaving the queue alone (it was not empty when we started)");
  }
  // A DJ announce that is still unwinding holds the volume lane (423) and can
  // swallow a room change, so both restores are retried rather than assumed.
  await retry("volume", async () => {
    if (restore.volume == null) return;
    const got = await nudgeVolumeTo(restore.volume);
    if (got !== restore.volume) throw new Error(`volume is ${got}, wanted ${restore.volume}`);
    console.log(`volume restored to ${restore.volume}`);
  });

  await retry("target room", async () => {
    await api("POST", "/api/groups/select", { room: restore.targetRoom });
    await sleep(1500);
    const now = (await api("GET", "/api/groups")).targetRoom;
    if (now !== restore.targetRoom) throw new Error(`target room is "${now}"`);
    console.log(`target room restored to "${restore.targetRoom}"`);
  });
}

async function retry(label, fn, attempts = 5) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await fn();
      return;
    } catch (err) {
      if (i === attempts) {
        console.warn(`could not restore ${label}: ${err.message}`);
        return;
      }
      await sleep(i * 3000);
    }
  }
}

let failure = null;
try {
  await main();
} catch (err) {
  failure = err;
  console.error(`\nERROR: ${err.message}`);
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
// process.exit() here trips a libuv assertion on Windows while sockets are
// still closing, which replaces the exit code with a crash code.
if (failure || failed.length) process.exitCode = 1;
