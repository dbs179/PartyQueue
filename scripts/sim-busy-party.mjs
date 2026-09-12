#!/usr/bin/env node
/**
 * Randomised busy-party simulation for single-row baked announces.
 *
 * Drives the REAL volume driver (src/dj-announce-volume.js) and the REAL trim
 * decision (src/sonos-queue-policy.js) against a modelled Sonos queue, while
 * guests pile on requests, Random tops the queue up, the host skips, and
 * maintenance trims played rows underneath it all.
 *
 * The four-row announce block this used to model is gone: an announce is now
 * one row, so "block got split" and "playhead landed in the wrong part of the
 * block" are no longer possible by construction. What IS still worth hammering
 * is what the new design can get wrong:
 *
 *   1. the room is left boosted or muted after an announce
 *   2. an unplayed guest request ends up stranded behind the playhead
 *   3. trim eats a row the playhead never reached
 *   4. an announce is separated from the song it was written to introduce
 *
 *   node scripts/sim-busy-party.mjs --parties 500 --seed 42 [--verbose]
 */
import { runAnnounceVolume } from "../src/dj-announce-volume.js";
import {
  trimPlayedDecision,
  findInsertPosition,
} from "../src/sonos-queue-policy.js";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.indexOf(`--${name}`);
  return hit >= 0 && argv[hit + 1] ? argv[hit + 1] : fallback;
};
const PARTIES = Number(flag("parties", 200));
const SEED = Number(flag("seed", 0)) || Math.floor(Math.random() * 1e9);
const VERBOSE = argv.includes("--verbose");
/** Disable the volume restore guard, to prove the simulation can see the bug. */
const NO_RESTORE = argv.includes("--no-restore");

/** Deterministic PRNG so a failing party can be replayed with --seed. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

const GUESTS = ["Dave", "Mel", "Jo", "Sam", "Kit", "Ash"];
const MUSIC_VOLUME = 8;
const ANNOUNCE_VOLUME = 20;

// ---------------------------------------------------------------------------
// Modelled speaker
// ---------------------------------------------------------------------------
class FakeSonos {
  constructor(rand) {
    this.rand = rand;
    this.rows = [];
    this.track = 0; // 1-based playhead; 0 = nothing playing
    this.positionSec = 0;
    this.volume = MUSIC_VOLUME;
    this.clock = 0;
    this.played = new Set();
    this.dropped = new Set();
    this.volumeLog = [];
    this.seq = 0;
  }

  row(n) {
    return this.rows[n - 1] ?? null;
  }
  get current() {
    return this.row(this.track);
  }

  add(kind, at = 0, extra = {}) {
    const n = this.seq++;
    const row = {
      kind,
      id: `${kind}-${n}`,
      // Spotify ids must be alphanumeric for spotifyTrackId() to parse them.
      url: extra.url ?? `x-sonos-spotify:spotify:track:sim${n}`,
      ...extra,
    };
    if (at >= 1 && at <= this.rows.length) this.rows.splice(at - 1, 0, row);
    else this.rows.push(row);
    // An insert at or before the playhead shifts what we are playing.
    if (at >= 1 && at <= this.track) this.track += 1;
    return row;
  }

  /** Queue in the shape the real policy functions expect. */
  items() {
    return this.rows.map((r) => ({ TrackUri: r.url, Title: r.id }));
  }

  /** Spotify ids of rows that came from a guest request. */
  searchedIds() {
    const ids = new Set();
    for (const r of this.rows) {
      if (r.kind === "song" && r.request) ids.add(`sim${r.id.split("-")[1]}`);
    }
    return ids;
  }

  advance() {
    if (this.track >= 1 && this.current) this.played.add(this.current.id);
    this.track = this.track < this.rows.length ? this.track + 1 : 0;
    this.positionSec = 0;
  }

  /** Remove rows [from, to] inclusive, 1-based, adjusting the playhead. */
  remove(from, to) {
    const removed = this.rows.splice(from - 1, to - from + 1);
    if (this.track >= from) this.track = Math.max(0, this.track - removed.length);
    return removed;
  }

  setVolume(level) {
    this.volume = level;
    this.volumeLog.push(level);
  }
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/** The room must never be left away from the music level once an announce ends. */
function checkVolumeSettled(sonos, failures, where) {
  const onAnnounce =
    sonos.current?.kind === "announce" && !sonos.dropped.has(sonos.current.id);
  if (!onAnnounce && sonos.volume !== MUSIC_VOLUME) {
    failures.push(
      `${where}: volume left at ${sonos.volume} (music level is ${MUSIC_VOLUME})`
    );
  }
}

/** Nothing a guest asked for may end up behind the playhead unplayed. */
function checkNothingStranded(sonos, failures, where) {
  for (let i = 1; i < sonos.track; i++) {
    const row = sonos.row(i);
    if (row?.kind === "song" && row.request && !sonos.played.has(row.id)) {
      failures.push(`${where}: stranded request ${row.id} at #${i} behind #${sonos.track}`);
    }
  }
}

/** Trim may only ever delete rows the playhead already passed. */
function checkTrimOnlyAtePlayed(removed, sonos, failures, where) {
  for (const row of removed) {
    if (!sonos.played.has(row.id)) {
      failures.push(
        `${where}: trim removed unplayed ${row.id}` +
          ` | track=${sonos.track} rows=[${sonos.rows.map((r) => r.id).join(",")}]` +
          ` played={${[...sonos.played].join(",")}}`
      );
    }
  }
}

/**
 * An announce must never end up behind the song it introduces — that would
 * mean the DJ teeing up a track the party already heard.
 *
 * Deliberately not an adjacency check: a guest request placed between the
 * announce and its song is allowed, and the app does that on purpose. Only the
 * ordering is a correctness property.
 */
function checkAnnounceStillAheadOfItsSong(sonos, failures, where) {
  sonos.rows.forEach((row, idx) => {
    if (row.kind !== "announce" || !row.introduces) return;
    if (sonos.played.has(row.id)) return;
    const songIdx = sonos.rows.findIndex((r) => r.id === row.introduces);
    if (songIdx >= 0 && songIdx < idx) {
      failures.push(
        `${where}: announce ${row.id} sits behind ${row.introduces} ` +
          `(#${idx + 1} vs #${songIdx + 1})`
      );
    }
  });
}

// ---------------------------------------------------------------------------
// One party
// ---------------------------------------------------------------------------
async function runParty(seed, stats) {
  const rand = rng(seed);
  const sonos = new FakeSonos(rand);
  const failures = [];
  const log = (m) => VERBOSE && console.log(`  [${seed}] ${m}`);

  // Seed the queue with a few songs and start playing.
  for (let i = 0; i < 3 + Math.floor(rand() * 3); i++) sonos.add("song");
  sonos.track = 1;

  const dropChance = rand() * 0.15;
  let activeAnnounce = null;
  let djTrimSkips = 0;

  const io = {
    now: () => sonos.clock,
    read: async () => ({
      uri: sonos.current?.url ?? "",
      positionSec: sonos.positionSec,
    }),
    setVolume: async (level) => {
      if (NO_RESTORE && level === MUSIC_VOLUME) return;
      sonos.setVolume(level);
    },
    sleep: async () => new Promise((r) => setImmediate(r)),
  };

  const steps = 40 + Math.floor(rand() * 60);
  for (let step = 0; step < steps && sonos.track >= 1; step++) {
    const roll = rand();

    if (roll < 0.16) {
      // A guest requests a song. Placed by the real policy, which is what
      // keeps an announce glued to the song it introduces.
      const guest = GUESTS[Math.floor(rand() * GUESTS.length)];
      const at = findInsertPosition(sonos.items(), {
        currentTrack: sonos.track,
        playingFromQueue: true,
        searchedIds: sonos.searchedIds(),
      });
      const song = sonos.add("song", at, { request: true, guest });
      log(`${guest} requested ${song.id} at #${at || "end"}`);
    } else if (roll < 0.3 && !activeAnnounce) {
      // The DJ announces the next upcoming song. A new announce supersedes any
      // pending one, exactly as insertAnnounceClip strips upcoming pads first —
      // two announces never stack in front of the same song.
      for (let i = sonos.rows.length; i > sonos.track; i--) {
        const row = sonos.row(i);
        if (row?.kind === "announce" && !sonos.played.has(row.id)) {
          log(`superseding pending ${row.id}`);
          sonos.remove(i, i);
        }
      }
      // Announce the next real song, never another announce row.
      let at = sonos.track + 1;
      while (at <= sonos.rows.length && sonos.row(at)?.kind !== "song") at += 1;
      const introduces = at <= sonos.rows.length ? sonos.row(at).id : null;
      if (introduces) {
        const clipUrl = `http://pq/media/tts/dj-announce-${sonos.seq}.mp3`;
        const durationSec = 18 + Math.floor(rand() * 20);
        const row = sonos.add("announce", at, {
          url: clipUrl,
          introduces,
          durationSec,
        });
        log(`announce ${row.id} at #${at} before ${introduces}`);
        stats.announces += 1;
        activeAnnounce = runAnnounceVolume(
          {
            clipUrl,
            durationSec,
            rampSec: 3,
            restoreSec: 3,
            musicVolume: MUSIC_VOLUME,
            announceVolume: ANNOUNCE_VOLUME,
          },
          io,
          { graceMs: 60_000, maxMs: 600_000 }
        ).then((r) => {
          activeAnnounce = null;
          return r;
        });
      }
    } else if (roll < 0.42) {
      // Random tops the queue up at the end.
      sonos.add("song");
    } else if (roll < 0.52) {
      // Host skip.
      log(`skip from #${sonos.track}`);
      sonos.advance();
      await settle();
    } else if (roll < 0.62) {
      // Maintenance trim, through the real decision function.
      const decision = trimPlayedDecision({
        track: sonos.track,
        queueLength: sonos.rows.length,
        handoffActive: false,
        handoffArmed: !!activeAnnounce,
        // Climbs while an announce holds trim off, so the guard cannot starve
        // trim for the whole night.
        djSkipStreak: djTrimSkips,
        currentUri: sonos.current?.url ?? "",
        currentTitle: "",
        playingFromQueue: true,
      });
      stats.trimDecisions[decision.reason ?? decision.action] =
        (stats.trimDecisions[decision.reason ?? decision.action] || 0) + 1;
      djTrimSkips =
        decision.reason === "dj-announce-armed" || decision.reason === "dj-handoff"
          ? djTrimSkips + 1
          : 0;
      if (decision.action === "trim") {
        // StartingIndex goes straight to RemoveTrackRangeFromQueue, which is
        // 1-based — the same convention as our rows.
        const from = decision.StartingIndex;
        const removed = sonos.remove(from, from + decision.NumberOfTracks - 1);
        checkTrimOnlyAtePlayed(removed, sonos, failures, `party ${seed} trim`);
        stats.trimmedRows += removed.length;
        log(`trimmed ${removed.length} row(s) -> track #${sonos.track}`);
      }
    } else if (roll < 0.68) {
      // Clear everything from the playhead forward.
      if (sonos.rows.length > sonos.track) {
        log(`clearing ${sonos.rows.length - sonos.track} upcoming row(s)`);
        sonos.remove(sonos.track + 1, sonos.rows.length);
      }
    } else {
      // Play out the current row.
      const row = sonos.current;
      if (!row) break;
      if (row.kind === "announce" && !sonos.dropped.has(row.id)) {
        if (rand() < dropChance) {
          // The speaker occasionally refuses to fetch a clip.
          log(`speaker dropped ${row.id}`);
          sonos.dropped.add(row.id);
          sonos.advance();
        } else {
          // Step through the clip so the driver sees ramp, hold and restore.
          const total = row.durationSec;
          for (const at of [0, 1.5, 3, total / 2, total - 1.5, total]) {
            sonos.positionSec = at;
            sonos.clock += 150;
            await settle();
          }
          sonos.advance();
        }
      } else {
        // Real track lengths are what set the maintenance cadence.
        sonos.clock += 150_000 + Math.floor(rand() * 90_000);
        sonos.advance();
      }
      await settle();
    }

    checkNothingStranded(sonos, failures, `party ${seed} step ${step}`);
    checkAnnounceStillAheadOfItsSong(sonos, failures, `party ${seed} step ${step}`);
    if (failures.length) break;
  }

  // Let any in-flight announce finish, then the room must be back to normal.
  sonos.clock += 600_000;
  await settle(50);
  if (activeAnnounce) await activeAnnounce;
  checkVolumeSettled(sonos, failures, `party ${seed} end`);

  return failures;
}

/** Yield enough macrotasks for the driver loop to make progress. */
function settle(times = 8) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) {
    p = p.then(() => new Promise((r) => setImmediate(r)));
  }
  return p;
}

// ---------------------------------------------------------------------------
const stats = { announces: 0, trimmedRows: 0, trimDecisions: {} };
const allFailures = [];

console.log(
  `simulating ${PARTIES} parties (seed ${SEED})` +
    (NO_RESTORE ? " [--no-restore: expecting failures]" : "")
);
for (let i = 0; i < PARTIES; i++) {
  const failures = await runParty(SEED + i, stats);
  if (failures.length) {
    allFailures.push(...failures);
    if (allFailures.length > 20) break;
  }
}

console.log(
  `\nannounces: ${stats.announces} | trimmed rows: ${stats.trimmedRows}`
);
console.log(`trim decisions: ${JSON.stringify(stats.trimDecisions)}`);

if (allFailures.length) {
  console.error(`\nFAILED (${allFailures.length}):`);
  for (const f of allFailures.slice(0, 20)) console.error(`  ${f}`);
  console.error(`\nreplay a party with: --parties 1 --seed <n> --verbose`);
  process.exit(1);
}
console.log("\nPASS — no stranded requests, no bad trims, volume always settled");
