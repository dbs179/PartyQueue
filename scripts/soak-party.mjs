#!/usr/bin/env node
/**
 * Multi-song soak against a real speaker: the territory smoke-async-add misses.
 *
 * That test only ever adds one song to an empty queue. The half of the
 * party-night incident we never reproduced was playback STOPPING partway
 * through, which can only happen where songs hand over to one another - track
 * transitions, the trim loop, and mid-set DJ shouts.
 *
 *   PQ_BASE=http://10.10.1.30:8088 node scripts/soak-party.mjs
 *   PQ_SOAK_ROOM=Office PQ_SOAK_MINUTES=30 ...
 *
 * Plays real music in the room at low volume, then restores the target room,
 * the volume it found, and an empty queue.
 */
import {
  api,
  ensureHostAuth,
  sleep,
  searchTrack,
  queueTracks,
  vol,
  nudgeVolumeTo,
} from "./smoke-lib.mjs";

const ROOM = process.env.PQ_SOAK_ROOM || "Office";
const FORCE = process.env.PQ_SOAK_FORCE === "1";
const TEST_VOLUME = Math.max(0, Math.min(30, Number(process.env.PQ_SOAK_VOLUME) || 8));
const RUN_MS = Math.max(1, Number(process.env.PQ_SOAK_MINUTES) || 13) * 60_000;
// Slower than the smoke test's poll: this runs for many minutes, and the point
// is to watch the party rather than to add read load of our own.
const POLL_MS = 5000;
// Nothing playing while songs are still waiting is the failure we are hunting.
// Allow a generous grace period: DJ announces legitimately pause the transport.
const STALL_MS = 45_000;

const stamp = (t) => {
  const s = Math.round(t / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

async function tolerant(label, fn, attempts = 10) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts) {
        console.log(`  gave up on ${label}: ${err.message.slice(0, 70)}`);
        return null;
      }
      await sleep(6000);
    }
  }
}

const SONGS = [
  ["Take On Me a-ha", "Ana"],
  ["Mr. Brightside The Killers", "Ben"],
  ["Blinding Lights The Weeknd", "Cara"],
  ["Don't Stop Believin Journey", "Dev"],
];
const MIDSET = ["Sweet Dreams Eurythmics", "Elle"];

let restore = null;
let mayClear = false;
const events = [];
const note = (t, msg) => {
  events.push(`${stamp(t)}  ${msg}`);
  console.log(`${stamp(t)}  ${msg}`);
};

async function addSong([query, guest], t) {
  const track = await searchTrack(query);
  const res = await api("POST", "/api/queue", {
    uri: track.uri,
    name: track.name,
    artist: track.artist,
    requestedBy: guest,
    requestedByUser: guest,
  }).catch((err) => ({ error: err.message }));
  note(t, `ADD  ${guest}: "${track.name}" -> ${res.error ? `REFUSED ${res.error}` : `pending=${res.pending}`}`);
}

async function main() {
  await ensureHostAuth();
  const live = await api("GET", "/api/queue/list");
  const np0 = await api("GET", "/api/nowplaying");
  // Cleanup empties the queue, so it may only run if we proved the queue was
  // empty first. This must never be the thing that deletes everyone's songs.
  if (!FORCE && (queueTracks(live).length || np0.state === "PLAYING")) {
    throw new Error(
      `the party looks live (${queueTracks(live).length} queued, transport ${np0.state}); ` +
        `this soak takes over the room and empties the queue. ` +
        `Set PQ_SOAK_FORCE=1 only if you are sure.`
    );
  }

  const groups = await api("GET", "/api/groups");
  restore = { targetRoom: groups.targetRoom, volume: null };
  await api("POST", "/api/groups/select", { room: ROOM });
  await sleep(1500);
  restore.volume = await vol();
  await tolerant("volume", () => nudgeVolumeTo(TEST_VOLUME));
  mayClear = true;
  console.log(
    `v${(await api("GET", "/api/health")).version} — ${ROOM}, volume ${restore.volume} -> ${TEST_VOLUME}` +
      `, running ${Math.round(RUN_MS / 60000)} min\n`
  );

  const t0 = Date.now();
  const el = () => Date.now() - t0;

  for (const song of SONGS) {
    await addSong(song, el());
    await sleep(4000);
  }

  let midsetDone = false;
  let lastTrack = null;
  let notPlayingSince = null;
  let stalls = 0;
  let transitions = 0;
  let lastLine = "";

  while (el() < RUN_MS) {
    const t = el();
    const q = await api("GET", "/api/queue/list").catch(() => null);
    const np = await api("GET", "/api/nowplaying").catch(() => null);
    const rows = q ? queueTracks(q) : [];
    const upcoming = rows.length;
    const state = np?.state || "?";
    const title = np?.title || "";

    if (title && title !== lastTrack) {
      if (lastTrack !== null) transitions += 1;
      note(t, `PLAY "${title}"  (upcoming ${upcoming})`);
      lastTrack = title;
    }

    // Stall detection: not playing while songs are still waiting to be heard.
    if (state !== "PLAYING" && upcoming > 0) {
      notPlayingSince ??= Date.now();
      if (Date.now() - notPlayingSince > STALL_MS) {
        stalls += 1;
        note(t, `*** STALL: ${state} for ${Math.round((Date.now() - notPlayingSince) / 1000)}s with ${upcoming} song(s) waiting ***`);
        notPlayingSince = Date.now(); // re-arm so it reports periodically
      }
    } else {
      notPlayingSince = null;
    }

    const line = `${state} up=${upcoming} stale=${!!q?.stale}`;
    if (line !== lastLine) {
      console.log(`${stamp(t)}  ${line} | "${title}"`);
      lastLine = line;
    }

    if (!midsetDone && t > RUN_MS * 0.45) {
      midsetDone = true;
      await addSong(MIDSET, el());
    }
    await sleep(POLL_MS);
  }

  console.log(`\n=== soak summary ===`);
  console.log(`track transitions observed: ${transitions}`);
  console.log(`stalls (>${STALL_MS / 1000}s not playing with songs waiting): ${stalls}`);
  console.log(`\nevents:\n${events.join("\n")}`);
}

async function cleanup() {
  if (!restore) return;
  console.log("\nrestoring...");
  await api("POST", "/api/pause").catch(() => {});
  if (mayClear) await tolerant("clear", () => api("POST", "/api/queue/clear"));
  await tolerant("volume", async () => {
    const got = await nudgeVolumeTo(restore.volume);
    if (got !== restore.volume) throw new Error(`volume is ${got}`);
  });
  await tolerant("target", async () => {
    await api("POST", "/api/groups/select", { room: restore.targetRoom });
    await sleep(2000);
    const g = await api("GET", "/api/groups");
    if (g.targetRoom !== restore.targetRoom) throw new Error(`target is ${g.targetRoom}`);
  });
  const g = await api("GET", "/api/groups");
  const q = await api("GET", "/api/queue/list");
  console.log(`targetRoom=${g.targetRoom} volume=${restore.volume} queue=${queueTracks(q).length}`);
}

try {
  await main();
} catch (err) {
  console.error(`\nERROR: ${err.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
