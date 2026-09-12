#!/usr/bin/env node
/**
 * Randomised busy-party simulator.
 *
 * Drives the real DJ volume handoff, the real announce-block locator and the
 * real trim decision against a modelled Sonos queue, with many guests adding
 * songs, dedications, shout-outs and banter announces while maintenance trims
 * behind the playhead. After every step it re-checks the invariants that the
 * 2026-09-11 party broke.
 *
 *   node scripts/sim-busy-party.mjs                 # 200 parties
 *   node scripts/sim-busy-party.mjs --parties 2000  # longer soak
 *   node scripts/sim-busy-party.mjs --seed 12345 --verbose
 */
import {
  beginDjVolumeHandoff,
  getDjVolumeHandoffState,
  isDjVolumeHandoffArmed,
  shiftDjVolumeHandoffPositions,
  cancelActiveDjVolumeHandoff,
} from "../src/dj-volume-handoff.js";
import { locateAnnounceBlockByClipUrl } from "../src/skip-announce-policy.js";
import {
  trimPlayedDecision,
  findInsertPosition,
} from "../src/sonos-queue-policy.js";
import { isDjVolumeHandoffActive } from "../src/dj-volume-handoff-state.js";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const PARTIES = Number(flag("parties", 200));
const SEED = Number(flag("seed", 0)) || Math.floor(Math.random() * 1e9);
const VERBOSE = argv.includes("--verbose");
/**
 * Trim even while an announce is armed, i.e. pretend the armed guard is not
 * there. Proves the live locator and the block-bounded seek hold the queue on
 * their own, instead of the whole fix resting on one flag.
 */
const IGNORE_ARMED = argv.includes("--ignore-armed");
/** Skip the post-trim position shift, leaving only the live clip lookup. */
const NO_SHIFT = argv.includes("--no-shift");

/** Deterministic PRNG so a failing party can be replayed with --seed. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const GUESTS = [
  "Dave",
  "Mark",
  "Alex",
  "Jen",
  "Sam",
  "Priya",
  "Tom",
  "Nina",
  "Chris",
  "Bex",
];
const RAMP = "http://pq/media/tts/silence-ramp-3s.mp3";
const RESTORE = "http://pq/media/tts/silence-3s.mp3";

// ---------------------------------------------------------------------------
// Modelled Sonos
// ---------------------------------------------------------------------------

class FakeSonos {
  constructor(log) {
    /** @type {Array<{uri:string, title:string, kind:string, songId?:number, requestedBy?:string, announceId?:number}>} */
    this.rows = [];
    this.track = 1;
    this.clock = 0;
    this.volume = 12;
    this.log = log;
    this.seeks = [];
    this.played = new Set();
    this.removedRows = [];
    /** Clips the speaker itself refused to start (not our fault to fix). */
    this.droppedClips = new Set();
  }

  row(n) {
    return this.rows[n - 1];
  }

  uri(n) {
    return this.row(n)?.uri ?? "";
  }

  items() {
    return this.rows.map((r) => ({ TrackUri: r.uri, Title: r.title }));
  }

  isPad(n) {
    const k = this.row(n)?.kind;
    return k === "ramp" || k === "tts" || k === "tts2" || k === "restore";
  }

  /** Advance the playhead one row, recording what actually got heard. */
  advance() {
    if (this.track > this.rows.length) return false;
    const cur = this.row(this.track);
    if (cur) this.played.add(cur.uri);
    if (this.track >= this.rows.length) return false;
    this.track += 1;
    return true;
  }

  seekTo(n) {
    const target = Math.max(1, Math.min(this.rows.length, Math.floor(n)));
    this.seeks.push({ from: this.track, to: target });
    this.log?.(`SEEK ${this.track} -> ${target} (${this.row(target)?.kind})`);
    this.track = target;
  }

  /** Rows removed from the front, exactly like RemoveTrackRangeFromQueue. */
  removeFront(count) {
    const gone = this.rows.splice(0, count);
    this.removedRows.push(...gone);
    this.track = Math.max(1, this.track - count);
    return gone;
  }

  insertAt(position, rows) {
    this.rows.splice(position - 1, 0, ...rows);
    if (position <= this.track) this.track += rows.length;
  }
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/**
 * Every announce block must stay contiguous and sit immediately before the song
 * it introduces. A block split by an insert means a guest request landed in the
 * middle of a shout.
 */
function checkBlocksIntact(sonos, failures, where) {
  const byId = new Map();
  sonos.rows.forEach((r, i) => {
    if (r.announceId == null) return;
    if (!byId.has(r.announceId)) byId.set(r.announceId, []);
    byId.get(r.announceId).push({ ...r, pos: i + 1 });
  });
  for (const [id, parts] of byId) {
    const positions = parts.map((p) => p.pos);
    const span = positions[positions.length - 1] - positions[0] + 1;
    if (span !== parts.length) {
      failures.push(
        `${where}: announce ${id} is split across rows ${positions.join(",")}`
      );
      continue;
    }
    // Trim eats the block from the front, so any suffix of the canonical order
    // is legal. What is not legal is the rows being shuffled.
    const rank = { ramp: 0, tts: 1, tts2: 2, restore: 3 };
    const ranks = parts.map((p) => rank[p.kind]);
    const ordered = ranks.every((r, i) => i === 0 || r > ranks[i - 1]);
    if (!ordered) {
      const kinds = parts.map((p) => p.kind).join(">");
      failures.push(`${where}: announce ${id} rows out of order (${kinds})`);
    }
  }
}

/**
 * The queue-loss bug: a guest request that never played must not end up behind
 * the playhead, because trim then deletes it as "already played".
 */
function checkNothingStranded(sonos, failures, where) {
  for (let n = 1; n < sonos.track; n++) {
    const r = sonos.row(n);
    if (!r || r.kind !== "song") continue;
    if (!sonos.played.has(r.uri)) {
      failures.push(
        `${where}: "${r.title}" (${r.requestedBy}) sits at row ${n} behind ` +
          `playhead ${sonos.track} but never played`
      );
    }
  }
}

/** Trim may only ever delete rows the playhead already passed. */
function checkTrimOnlyAtePlayed(sonos, failures, where) {
  for (const r of sonos.removedRows) {
    if (r.kind !== "song") continue;
    if (!sonos.played.has(r.uri)) {
      failures.push(
        `${where}: trim deleted unplayed request "${r.title}" (${r.requestedBy})`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// One party
// ---------------------------------------------------------------------------

async function runParty(seed) {
  const rand = rng(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const chance = (p) => rand() < p;

  const events = [];
  const log = (msg) => {
    events.push(msg);
    if (VERBOSE) console.log("   " + msg);
  };

  const sonos = new FakeSonos((m) => log(m));
  const failures = [];
  let songSeq = 0;
  let announceSeq = 0;
  let lastTrimAt = 0;
  const volumeWriteMs = 60 + Math.floor(rand() * 650);
  const dropClipChance = rand() * 0.5;
  const stats = { trims: 0, trimmedRows: 0, shifts: 0, trimSkips: {} };
  let djSkipStreak = 0;
  const announcesArmed = [];
  const announcesHeard = new Set();

  /** Guest requests, so findInsertPosition puts new ones below them. */
  const searchedIds = new Set();

  // Seed the queue with filler so the party starts mid-set like a real night.
  for (let i = 0; i < 4 + Math.floor(rand() * 4); i++) {
    songSeq += 1;
    sonos.rows.push({
      uri: `spotify:track:fill${songSeq}`,
      title: `Filler ${songSeq}`,
      kind: "song",
      songId: songSeq,
      requestedBy: "Playlist",
    });
  }

  // -- adapter: the handoff drives the modelled speaker through this ----------
  const adapter = {
    async getNowPlaying() {
      sonos.clock += 150;
      const uri = sonos.uri(sonos.track);
      const kind = sonos.row(sonos.track)?.kind;
      // Pads and clips drain on their own; songs are held by the driver so the
      // simulation does not have to burn a full track length per row.
      const dwell =
        kind === "ramp" || kind === "restore"
          ? 3000
          : kind === "tts" || kind === "tts2"
            ? 2500
            : Infinity;
      if (sonos.padStartedAt == null || sonos.padRow !== sonos.track) {
        sonos.padRow = sonos.track;
        sonos.padStartedAt = sonos.clock;
      }
      if (sonos.clock - sonos.padStartedAt >= dwell) {
        sonos.advance();
        // Sonos sometimes refuses to start an http:// clip and falls straight
        // through it. That drop is exactly what recoverSkippedDjClip is for,
        // and it is the only way the seek paths get exercised now that the
        // shortened ramp lets the pad advance on its own.
        const nextKind = sonos.row(sonos.track)?.kind;
        if (
          (nextKind === "tts" || nextKind === "tts2") &&
          rand() < dropClipChance
        ) {
          log(`sonos dropped clip at row ${sonos.track}`);
          sonos.droppedClips.add(sonos.uri(sonos.track));
          sonos.advance();
        }
        sonos.padRow = sonos.track;
        sonos.padStartedAt = sonos.clock;
      }
      if (kind === "tts" || kind === "tts2") announcesHeard.add(uri);
      return {
        uri,
        state: "PLAYING",
        positionSec: kind === "tts" || kind === "tts2" ? 2 : 0,
      };
    },
    async getVolume() {
      return sonos.volume;
    },
    async setVolume(level) {
      sonos.volume = level;
      // Congested SOAP is what used to eat the pre-silence pad and push the
      // handoff onto its SeekTrack branch, so vary it hard across parties.
      sonos.clock += volumeWriteMs;
      return { locked: true };
    },
    async pause() {},
    async resume() {},
    async playAt(n) {
      sonos.seekTo(n);
      sonos.padRow = sonos.track;
      sonos.padStartedAt = sonos.clock;
    },
    async next() {
      const from = sonos.track;
      sonos.advance();
      log(`NEXT ${from} -> ${sonos.track} (${sonos.row(sonos.track)?.kind})`);
      sonos.padRow = sonos.track;
      sonos.padStartedAt = sonos.clock;
    },
    async locateAnnounce(clipUrl) {
      return locateAnnounceBlockByClipUrl(sonos.items(), clipUrl, {
        currentTrack: sonos.track,
        playingFromQueue: true,
      });
    },
  };

  // -- actors ----------------------------------------------------------------

  const addSong = (requestedBy, { dedication = false } = {}) => {
    songSeq += 1;
    const row = {
      uri: `spotify:track:sim${songSeq}`,
      title: `Song ${songSeq}`,
      kind: "song",
      songId: songSeq,
      requestedBy,
      dedication: dedication ? `for ${pick(GUESTS)}` : null,
    };
    // Real inserts go through findInsertPosition: bottom of the request block,
    // above filler, and never between a shout and the song it introduces.
    const position = findInsertPosition(sonos.items(), {
      currentTrack: sonos.track,
      playingFromQueue: true,
      searchedIds,
    });
    const at = position >= 1 ? position : sonos.rows.length + 1;
    sonos.insertAt(at, [row]);
    searchedIds.add(`sim${songSeq}`);
    log(`add "${row.title}" by ${requestedBy} at ${at}`);
    return { row, at };
  };

  const insertAnnounce = (songRow, { banter = false } = {}) => {
    const songIdx = sonos.rows.indexOf(songRow);
    if (songIdx < 0) return null;
    const position = songIdx + 1;
    if (position <= sonos.track) return null; // already playing / behind
    announceSeq += 1;
    const id = announceSeq;
    const clip = `http://pq/media/tts/tts-${id}.mp3`;
    const rows = [
      { uri: RAMP, title: "PartyQueue Volume Ramp", kind: "ramp", announceId: id },
      { uri: clip, title: "DJ Holy Roller", kind: "tts", announceId: id },
    ];
    if (banter) {
      rows.push({
        uri: `http://pq/media/tts/tts-${id}-punch.mp3`,
        title: "Sister Static",
        kind: "tts2",
        announceId: id,
      });
    }
    rows.push({
      uri: RESTORE,
      title: "PartyQueue Silence Bridge",
      kind: "restore",
      announceId: id,
    });
    sonos.insertAt(position, rows);
    log(
      `announce ${id} ${banter ? "(banter) " : ""}before "${songRow.title}" ` +
        `at ramp@${position} tts@${position + 1}`
    );
    return { id, clip, rampPosition: position, rows, songRow };
  };

  const armAnnounce = async (ann) => {
    const idx = sonos.rows.findIndex((r) => r.uri === ann.clip);
    if (idx < 0) return;
    const ttsPosition = idx + 1;
    const tts2 = sonos.rows[idx + 1]?.kind === "tts2" ? idx + 2 : null;
    const musicIdx = sonos.rows.findIndex(
      (r, i) => i > idx && r.kind === "song"
    );
    const handoff = await beginDjVolumeHandoff({
      publicUrl: ann.clip,
      approxDurationSec: 8,
      silenceSec: 3,
      adapter,
      // Must yield a macrotask: a microtask-only sleep starves the driver loop
      // and the handoff then spins forever waiting for a queue that never moves.
      sleep: () => new Promise((r) => setImmediate(r)),
      now: () => sonos.clock,
      pollMs: 0,
      rampStepMs: 0,
      calculateTarget: () => 26,
      ttsPosition,
      tts2Position: tts2,
      musicPosition: musicIdx >= 0 ? musicIdx + 1 : ttsPosition + 2,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    if (handoff.deferred) {
      log(`announce ${ann.id} deferred behind the active handoff`);
      return;
    }
    announcesArmed.push({ ...ann, handoff, armedAt: sonos.clock });
    log(`announce ${ann.id} armed tts@${ttsPosition}`);
    // Run the handoff alongside the party rather than blocking the driver.
    handoff.start().catch(() => {});
  };

  const runTrim = () => {
    const pos = { Track: sonos.track };
    const decision = trimPlayedDecision({
      track: pos.Track,
      queueLength: sonos.rows.length,
      handoffActive: isDjVolumeHandoffActive(),
      handoffArmed: IGNORE_ARMED ? false : isDjVolumeHandoffArmed(),
      djSkipStreak,
      currentUri: sonos.uri(sonos.track),
      currentTitle: sonos.row(sonos.track)?.title ?? "",
      playingFromQueue: true,
    });
    djSkipStreak =
      decision.reason === "dj-handoff" || decision.reason === "dj-announce-armed"
        ? djSkipStreak + 1
        : 0;
    if (decision.action !== "trim") {
      stats.trimSkips[decision.reason] =
        (stats.trimSkips[decision.reason] ?? 0) + 1;
      log(`trim skip (${decision.reason})`);
      return;
    }
    sonos.removeFront(decision.NumberOfTracks);
    const shifted = NO_SHIFT
      ? false
      : shiftDjVolumeHandoffPositions(decision.NumberOfTracks);
    stats.trims += 1;
    stats.trimmedRows += decision.NumberOfTracks;
    if (shifted) stats.shifts += 1;
    log(`trim removed ${decision.NumberOfTracks}; playhead now ${sonos.track}`);
  };

  // -- the night ------------------------------------------------------------
  const pendingAnnounces = [];
  const STEPS = 120;
  const wallDeadline = Date.now() + 8000;
  for (let step = 0; step < STEPS; step++) {
    if (Date.now() > wallDeadline) {
      failures.push(`step ${step}: party did not finish within 8s (stuck?)`);
      break;
    }
    // Let the active handoff poll a few times between party events.
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));

    const roll = rand();
    if (roll < 0.3) {
      // Guest request, usually with a shout.
      const guest = pick(GUESTS);
      const { row } = addSong(guest, { dedication: chance(0.25) });
      if (chance(0.7)) {
        const ann = insertAnnounce(row, { banter: chance(0.3) });
        if (ann) pendingAnnounces.push(ann);
      }
    } else if (roll < 0.4) {
      // Two guests add at almost the same moment (the supersede path).
      const a = addSong(pick(GUESTS));
      const b = addSong(pick(GUESTS));
      for (const r of [a.row, b.row]) {
        const ann = insertAnnounce(r, { banter: chance(0.3) });
        if (ann) pendingAnnounces.push(ann);
      }
    } else if (roll < 0.5) {
      // A song plays all the way through. Real track lengths are what set the
      // maintenance cadence, and trim only misbehaves across many ticks.
      if (!sonos.isPad(sonos.track)) {
        sonos.clock += 150_000 + Math.floor(rand() * 90_000);
        sonos.advance();
      } else {
        sonos.clock += 1000;
      }
    } else if (roll < 0.55) {
      // Host skip, part way through.
      sonos.clock += 20_000 + Math.floor(rand() * 40_000);
      if (!sonos.isPad(sonos.track)) {
        sonos.advance();
        log(`host skip -> row ${sonos.track}`);
      }
    } else {
      sonos.clock += 5_000 + Math.floor(rand() * 20_000);
    }

    // Arm whatever is waiting, one at a time, exactly like production.
    while (
      pendingAnnounces.length &&
      getDjVolumeHandoffState().phase === "idle"
    ) {
      await armAnnounce(pendingAnnounces.shift());
    }

    // Maintenance tick every 45s of simulated time.
    if (sonos.clock - lastTrimAt >= 45_000) {
      lastTrimAt = sonos.clock;
      runTrim();
    }

    checkBlocksIntact(sonos, failures, `step ${step}`);
    checkNothingStranded(sonos, failures, `step ${step}`);
    checkTrimOnlyAtePlayed(sonos, failures, `step ${step}`);
    if (failures.length) break;
  }

  await cancelActiveDjVolumeHandoff("sim end").catch(() => {});
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));

  // An announce the playhead walked past must have been heard. A clip the
  // speaker itself refused to start is a Sonos fault and only gets counted;
  // one we seeked past is the bug this whole investigation was about.
  let dropped = 0;
  let skipped = 0;
  for (const ann of announcesArmed) {
    if (sonos.rows.some((r) => r.uri === ann.clip)) continue; // still upcoming
    if (announcesHeard.has(ann.clip)) continue;
    if (sonos.droppedClips.has(ann.clip)) {
      dropped += 1;
      continue;
    }
    skipped += 1;
    failures.push(`announce ${ann.id} was seeked past without ever playing`);
  }

  return {
    failures,
    events,
    sonos,
    announcesHeard,
    announcesArmed,
    skipped,
    dropped,
    stats,
  };
}

// ---------------------------------------------------------------------------

console.log(`busy-party sim: ${PARTIES} parties, base seed ${SEED}`);
let failed = 0;
let totalSeeks = 0;
let totalAnnounces = 0;
let totalHeard = 0;
let totalDropped = 0;
let totalRecovered = 0;
const agg = { trims: 0, trimmedRows: 0, shifts: 0, trimSkips: {} };

for (let p = 0; p < PARTIES; p++) {
  const seed = SEED + p;
  let result;
  try {
    result = await runParty(seed);
  } catch (err) {
    console.error(`\nPARTY ${p} (seed ${seed}) THREW: ${err.stack}`);
    failed += 1;
    if (failed >= 3) break;
    continue;
  }
  totalSeeks += result.sonos.seeks.length;
  totalAnnounces += result.announcesArmed.length;
  totalHeard += result.announcesHeard.size;
  totalDropped += result.dropped;
  agg.trims += result.stats.trims;
  agg.trimmedRows += result.stats.trimmedRows;
  agg.shifts += result.stats.shifts;
  for (const [reason, n] of Object.entries(result.stats.trimSkips)) {
    agg.trimSkips[reason] = (agg.trimSkips[reason] ?? 0) + n;
  }
  totalRecovered += [...result.sonos.droppedClips].filter((u) =>
    result.announcesHeard.has(u)
  ).length;
  if (result.failures.length) {
    failed += 1;
    console.error(`\nPARTY ${p} FAILED (replay: --seed ${seed} --parties 1)`);
    for (const f of result.failures.slice(0, 6)) console.error("  ! " + f);
    console.error("  last events:");
    for (const e of result.events.slice(-14)) console.error("    " + e);
    if (failed >= 3) break;
  }
}

console.log(
  `\narmed ${totalAnnounces} announces, heard ${totalHeard}, ` +
    `${totalSeeks} seeks, ${totalRecovered} clips recovered after a speaker ` +
    `drop, ${totalDropped} drops not recovered`
);
console.log(
  `trim: ${agg.trims} ticks removed ${agg.trimmedRows} rows ` +
    `(${agg.shifts} shifted a live announce); skips ` +
    JSON.stringify(agg.trimSkips)
);
if (failed) {
  console.error(`FAIL: ${failed} parties broke an invariant`);
  process.exit(1);
}
console.log("PASS: all parties kept the queue intact");
