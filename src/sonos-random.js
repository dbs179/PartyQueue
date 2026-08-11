import { MetaDataHelper } from "@svrooij/sonos";
import { withSonosWriteLock } from "./sonos-lock.js";
import { getManager, resolveCoordinator, resolveRegion } from "./sonos-core.js";
import { getNowPlayingFresh, invalidateSonosSnapshots } from "./sonos-snapshots.js";
import {
  enqueueMeta,
  autoStartIfIdle,
  holdIdleForDeferredShout,
} from "./sonos-queue-mutations.js";
import { ensureOrderedPlayModeOn } from "./sonos-transport.js";
import {
  autoStartDecision,
  isDjVoiceUri,
  isDjSilenceUri,
  isDjSilenceTrack,
} from "./sonos-queue-policy.js";
import { buildPlaylistPool } from "./spotify.js";
import {
  spotifyTrackId,
  pickWithRelaxation,
  discoveryPlan,
  primaryArtist,
  mixPlaylistAndDiscovery,
  cloneArtistCountMap,
  enforceUniqueArtistsInBatch,
  ensurePlaylistLead,
  allowSameArtistBatch,
} from "./sampler.js";
import {
  noteRandomSetBuilt,
  getSetsSinceLastSameArtistBatch,
  pickShowcaseArtistFromPlaylists,
  filterPlaylistsByPrimaryArtist,
} from "./same-artist-batch.js";
import {
  reactionSetDue,
  pickReactionSetTracks,
  noteReactionSetPlayed,
  noteReactionSetBuilt,
} from "./reaction-sets.js";
import {
  recentTrackIds,
  recentEntries,
  artistCountsInWindow,
  artistCooldowns,
  recordPlayed,
  tickArtistCooldowns,
} from "./play-history.js";
import { getRandomnessSettings } from "./settings.js";
import {
  artistMatchesGenres,
  bucketsForArtistSync,
  bucketsForArtist,
} from "./genres.js";
import { moodPack as eraMoodPack, getMoodHits, trackFitsMood } from "./moods.js";
import {
  pickSetLane,
  fitsExactLane,
  getGenreFlowState,
  recordGenreLane,
} from "./genre-flow.js";
import { getSimilarUris, isDiscoveryAvailable } from "./similar.js";
import { getLaneHits } from "./lane-hits.js";
import { markOrigin } from "./queue-origin.js";
import { queueWorkWasPreempted } from "./queue-preempt.js";

// Add `count` random tracks drawn from the host's playlists. Picks one song per
// randomly-chosen playlist (rotating playlists), avoids the same artist back-to-
// back, skips anything already in the queue, skips songs/artists played too
// recently (recent-song memory + per-artist budget), never repeats a song, and
// keeps topping up (re-sampling) until `count` songs are actually enqueued or
// the pool of new songs runs out. Uses the cached per-playlist pool.
//
// Split into plan (Spotify/sampler, no write lock) + enqueue (Sonos write lock)
// so DJ script/TTS can overlap with Sonos adds on the Random route.
export async function planRandomFromPlaylists(
  count = 50,
  playlistIds = null,
  genres = null,
  opts = {}
) {
  return buildRandomPlan(count, playlistIds, genres, opts);
}

export async function enqueueRandomBatch(plan, opts = {}) {
  return withSonosWriteLock(() => enqueueRandomBatchUnlocked(plan, opts));
}

export async function addRandomFromPlaylists(
  count = 50,
  playlistIds = null,
  genres = null,
  opts = {}
) {
  const plan = await planRandomFromPlaylists(count, playlistIds, genres, opts);
  return enqueueRandomBatch(plan, opts);
}

async function buildRandomPlan(
  count = 50,
  playlistIds = null,
  genres = null,
  opts = {}
) {
  const planStarted = Date.now();
  const wasPreempted = () =>
    opts.preemptGeneration != null &&
    queueWorkWasPreempted(opts.preemptGeneration);
  const m = await getManager();

  const playlists = await buildPlaylistPool();
  console.log(
    `[random] pool ready in ${Date.now() - planStarted}ms (${playlists.length} playlist(s))`
  );
  const afterPoolAt = Date.now();
  let usable = playlists.filter((p) => (p.tracks || []).length > 0);

  // When a specific set of playlist IDs is provided, only draw from those.
  // (null/undefined = draw from all playlists.)
  if (Array.isArray(playlistIds)) {
    const allow = new Set(playlistIds);
    usable = usable.filter((p) => allow.has(p.id));
    if (usable.length === 0) {
      throw new Error("No tracks in the selected playlists.");
    }
  } else if (usable.length === 0) {
    throw new Error("No tracks found in your playlists.");
  }

  // Genre filter: keep only tracks whose artist falls in an enabled bucket.
  // null/undefined = no filtering. Unresolved artists count as "Other".
  if (Array.isArray(genres)) {
    const enabled = new Set(genres);
    usable = usable
      .map((p) => ({
        ...p,
        tracks: (p.tracks || []).filter((t) => artistMatchesGenres(t.artist, enabled)),
      }))
      .filter((p) => p.tracks.length > 0);
    if (usable.length === 0) {
      throw new Error("No songs match the selected genres.");
    }
  }

  // Content filter: drop explicit tracks when the host has the filter on.
  if (opts.filterExplicit) {
    usable = usable
      .map((p) => ({ ...p, tracks: (p.tracks || []).filter((t) => !t.explicit) }))
      .filter((p) => p.tracks.length > 0);
    if (usable.length === 0) {
      throw new Error("No non-explicit songs available with the current filters.");
    }
  }

  // Era mood: keep only playlist tracks released in the mood's window. Unlike
  // the genre filter, an empty result is NOT an error — the mood's whole point
  // is that the external era top-up covers what the library can't.
  const activeMoodPack = eraMoodPack(opts.mood);
  if (activeMoodPack) {
    usable = usable
      .map((p) => ({
        ...p,
        tracks: (p.tracks || []).filter((t) => trackFitsMood(t, activeMoodPack)),
      }))
      .filter((p) => p.tracks.length > 0);
    if (usable.length === 0) {
      console.log(
        `[moods] no ${activeMoodPack.id} tracks in the selected playlists — filling from era charts`
      );
    }
  }

  // Track IDs to avoid: already in the queue, plus (as we go) ones we've already
  // enqueued or that failed to enqueue. This lets us re-sample to fill `count`.
  const coordinator = await resolveCoordinator(m);
  const queue = await coordinator.GetQueue();
  console.log(
    `[random] queue snapshot in ${Date.now() - afterPoolAt}ms`
  );
  const queueItems = Array.isArray(queue.Result) ? queue.Result : [];
  // 1-based index where this batch will land (append). DJ set announce inserts
  // immediately before this so Random/Discover stay under guest requests.
  const firstAppendPosition = queueItems.length + 1;
  const exclude = new Set(
    queueItems.map((t) => spotifyTrackId(t.TrackUri)).filter(Boolean)
  );

  // Prefer not starting a new batch with the same artist that's already at the
  // end of the live queue (or currently playing if the queue is empty/idle).
  let queueTailArtist = null;
  for (let i = queueItems.length - 1; i >= 0; i--) {
    const t = queueItems[i];
    if (isDjSilenceTrack(t.TrackUri, t.Title)) continue;
    if (isDjVoiceUri(t.TrackUri) && !isDjSilenceUri(t.TrackUri)) continue;
    queueTailArtist = primaryArtist(t.Artist);
    if (queueTailArtist) break;
  }
  if (!queueTailArtist) {
    try {
      const np = await getNowPlayingFresh();
      if (np && !np.djVoice && !np.djSilence) {
        queueTailArtist = primaryArtist(np.artist);
      }
    } catch {
      /* ignore */
    }
  }

  // Randomness memory: skip songs played too recently (Settings → songMemory
  // window only), and keep any one artist from dominating the recent window.
  // History on disk keeps up to HISTORY_CAP for the Memory UI; that longer
  // list is NOT the Random anti-repeat set.
  // Seeded from persisted history; refreshed from disk before top-up so the
  // budget stays accurate after recordPlayed. Also soft-prefer genre continuity
  // with the last few heard songs, and hard-block artists on skip cooldown.
  const cfg = getRandomnessSettings();
  const recentIds = recentTrackIds(cfg.songMemory);
  let artistSeed = artistCountsInWindow(cfg.artistWindow);
  const blockedArtists = new Set(
    [...artistCooldowns().keys()].map(primaryArtist).filter(Boolean)
  );
  const recentBuckets = new Set();
  for (const e of recentEntries(3)) {
    let buckets = bucketsForArtistSync(e.artist);
    if (!buckets.length) buckets = ["other"];
    for (const b of buckets) recentBuckets.add(b);
  }
  cfg.blockedArtists = blockedArtists;
  cfg.recentBuckets = recentBuckets;
  cfg.bucketsFor = bucketsForArtistSync;
  cfg.lastArtist = queueTailArtist;

  // Most Loved / Most Hated: every-N, genre-agnostic, uniform sample from
  // reaction pool. Checked before same-artist showcase; Loved wins ties.
  // Independent schedules: if Loved is due but unfillable, Hated may still play.
  const reactionSetSize = Math.max(1, Math.floor(Number(count) || 5));
  let reactionSetKind = null;
  for (const kind of ["loved", "hated"]) {
    if (!reactionSetDue(kind, cfg)) continue;
    const picked = pickReactionSetTracks(kind, reactionSetSize, {
      excludeIds: exclude,
    });
    if (!picked?.length) continue;
    reactionSetKind = kind;
    const order = picked.map((t) => ({
      uri: t.uri,
      id: t.id,
      artist: t.artist || "",
      name: t.name || "",
      discovered: false,
      moodPick: false,
      reactionSet: kind,
    }));
    const batchArtists = new Set();
    for (const item of order) {
      const a = primaryArtist(item.artist);
      if (a) batchArtists.add(a);
    }
    const artistByUri = new Map();
    const nameByUri = new Map();
    for (const item of order) {
      artistByUri.set(item.uri, item.artist);
      nameByUri.set(item.uri, item.name);
    }
    console.log(`[random] reaction set=${kind} size=${order.length}`);
    return {
      count,
      genres,
      opts,
      order,
      usable: [],
      exclude,
      recentIds,
      cfg,
      batchArtists,
      allowSameArtist: false,
      lastPlaylistArtist: null,
      batchArtistSeed: cloneArtistCountMap(
        artistCountsInWindow(cfg.artistWindow)
      ),
      blockedArtists,
      totalTarget: order.length,
      similarWant: 0,
      setLane: null,
      activeMoodPack: null,
      showcaseArtistKey: null,
      showcaseArtistName: null,
      reactionSetKind,
      firstAppendPosition,
      queueTotalBefore: queueItems.length,
      libraryIds: new Set(),
      artistByUri,
      nameByUri,
      relaxedArtist: false,
      relaxedMemory: false,
      memoryReuseCount: 0,
      laneHitAdded: 0,
      highlightsPreview: order.slice(0, 8).map((t) => ({
        artist: t.artist || "",
        name: t.name || "",
        discovered: false,
      })),
      similarAddedPreview: 0,
      moodAddedPreview: 0,
      preemptGeneration: opts.preemptGeneration,
    };
  }

  // Same-artist showcase: automatic every-N from the current Mood/Genre pool.
  // Filters the pool to one artist; Discover / lane-hits / era top-ups off.
  let showcaseArtistKey = null;
  let showcaseArtistName = null;
  if (allowSameArtistBatch(cfg, getSetsSinceLastSameArtistBatch())) {
    const picked = pickShowcaseArtistFromPlaylists(usable, {
      minTracks: Math.min(3, Math.max(2, Number(count) || 2)),
      excludeKeys: blockedArtists,
    });
    if (picked) {
      showcaseArtistKey = picked.key;
      showcaseArtistName = picked.name;
    }
  }
  if (showcaseArtistKey) {
    const filtered = filterPlaylistsByPrimaryArtist(usable, showcaseArtistKey);
    const n = filtered.reduce((sum, p) => sum + (p.tracks?.length || 0), 0);
    if (n >= 1) {
      usable = filtered;
      cfg.artistCap = Math.max(cfg.artistCap, Math.max(1, Number(count) || 1));
      console.log(
        `[random] same-artist showcase: ${showcaseArtistName} (${n} tracks, auto)`
      );
    } else {
      console.warn(
        `[random] same-artist showcase skipped — no tracks for ${showcaseArtistName}`
      );
      showcaseArtistKey = null;
      showcaseArtistName = null;
    }
  }

  // Discovery is carved out of the requested count, with at least half of every
  // batch retained for selected playlists (Random 2 => one playlist + one discovery).
  // Showcase batches are playlist-only for that artist.
  const plan = discoveryPlan(
    count,
    showcaseArtistKey
      ? 0
      : Math.max(0, Math.min(50, Math.round(opts.similarCount || 0)))
  );
  const similarWant = plan.similarWant;
  const playlistWant = plan.playlistWant;
  const totalTarget = plan.totalTarget;

  // Genre-lane flow: rotate primary lane across sets, bridge the first picks
  // from the previous lane, soft-prefer compatible neighbors within the set.
  // The rotation only considers lanes the filtered pool (era window, genre
  // filter, explicit filter already applied) actually has songs for — a lane
  // the pool can't serve turns the whole set into neighbor fallbacks.
  // Showcase: no lane hard-filter (pool is already one artist).
  const enabledLanePool = Array.isArray(genres) ? genres : null;
  const lanePoolCounts = new Map();
  for (const pl of usable) {
    for (const t of pl.tracks || []) {
      let buckets = bucketsForArtistSync(t.artist);
      if (!buckets.length) buckets = ["other"];
      for (const b of new Set(buckets)) {
        lanePoolCounts.set(b, (lanePoolCounts.get(b) ?? 0) + 1);
      }
    }
  }
  const flowPrev = getGenreFlowState();
  const setLane = pickSetLane({
    enabled: enabledLanePool,
    previousLane: flowPrev.lastLane,
    recentLanes: flowPrev.recentLanes,
    salt:
      (playlistWant || count || 0) +
      (recentBuckets.size || 0) +
      String(queueTailArtist || "").length,
    poolCounts: lanePoolCounts,
    minPerLane: Math.max(2, Math.min(4, playlistWant || count || 2)),
  });
  let tailBuckets = [];
  if (queueTailArtist) {
    tailBuckets = bucketsForArtistSync(queueTailArtist);
    if (!tailBuckets.length) tailBuckets = ["other"];
  } else if (recentBuckets.size) {
    tailBuckets = [...recentBuckets];
  }
  if (showcaseArtistKey) {
    cfg.flowState = null;
  } else {
    cfg.flowState = {
      lane: setLane,
      previousLane: flowPrev.lastLane,
      bridgeLeft: 0,
      lastBuckets: new Set(tailBuckets),
    };
  }
  console.log(
    `[random] genre lane=${setLane || "?"} exact` +
      (flowPrev.lastLane ? ` (was ${flowPrev.lastLane})` : "") +
      (showcaseArtistKey ? ` showcase=${showcaseArtistName}` : "")
  );

  const artistByUri = new Map();
  const nameByUri = new Map();
  for (const pl of usable) {
    for (const t of pl.tracks || []) {
      artistByUri.set(t.uri, t.artist ?? "");
      nameByUri.set(t.uri, t.name ?? "");
    }
  }

  // 1) Collect the playlist picks up front (pure, no enqueue) so we can mix the
  // discoveries in rather than tacking them on at the end. Mark them excluded so
  // discovery can't duplicate them.
  let relaxedArtist = false;
  let relaxedMemory = false;
  let memoryReuseCount = 0;
  const pickStarted = Date.now();
  const firstPick = pickWithRelaxation(
    usable,
    exclude,
    playlistWant,
    recentIds,
    artistSeed,
    cfg
  );
  console.log(
    `[random] playlist picks in ${Date.now() - pickStarted}ms` +
      ` want=${playlistWant} got=${firstPick.uris.length}`
  );
  const playlistUris = firstPick.uris;
  relaxedArtist = firstPick.relaxedArtist;
  relaxedMemory = firstPick.relaxedMemory;
  memoryReuseCount = firstPick.memoryReuseCount;
  for (const uri of playlistUris) {
    const id = spotifyTrackId(uri);
    if (id) exclude.add(id);
  }

  // Per-batch unique artists (playlist + Discover + lane/mood). Showcase
  // batches keep multiple tracks by the same artist.
  const allowSameArtist = !!showcaseArtistKey;
  const batchArtists = new Set();
  const claimBatchArtist = (artist) => {
    const a = primaryArtist(artist);
    if (a) batchArtists.add(a);
    return a;
  };
  const syncBatchArtistBlocks = () => {
    if (allowSameArtist) {
      cfg.blockedArtists = blockedArtists;
      return cloneArtistCountMap(artistCountsInWindow(cfg.artistWindow));
    }
    cfg.blockedArtists = new Set([...blockedArtists, ...batchArtists]);
    const seed = cloneArtistCountMap(artistCountsInWindow(cfg.artistWindow));
    for (const a of batchArtists) {
      seed.set(a, Math.max(seed.get(a) ?? 0, cfg.artistCap));
    }
    return seed;
  };

  // Prefer discoveries from a different artist than the last playlist pick.
  let lastPlaylistArtist = queueTailArtist;
  for (const uri of playlistUris) {
    const artist = claimBatchArtist(artistByUri.get(uri));
    if (artist) lastPlaylistArtist = artist;
  }
  let batchArtistSeed = syncBatchArtistBlocks();

  // 2) Outside-library slots: era charts (mood on) or Songs Like Discover.
  // Exact lane only — no neighbor soft-fit and no off-lane Discover retry.
  // Wall-clock budget so Random HTTP can return quickly; playlist picks already
  // cover most of the batch if Discover/lane-hits are slow.
  const OUTSIDE_SLOT_BUDGET_MS = 5_500;
  let discoveries = [];
  let laneHitAdded = 0;
  const libraryIds = new Set();
  for (const pl of playlists) {
    for (const t of pl.tracks || []) {
      const id = spotifyTrackId(t.uri);
      if (id) libraryIds.add(id);
    }
  }

  const outsideStarted = Date.now();
  const outsideAc = new AbortController();
  const outsideTimer = setTimeout(
    () => outsideAc.abort(),
    OUTSIDE_SLOT_BUDGET_MS
  );
  const outsideSignal = outsideAc.signal;
  try {
    if (!showcaseArtistKey && similarWant > 0 && activeMoodPack) {
      try {
        discoveries = await getMoodHits({
          mood: activeMoodPack.id,
          count: similarWant,
          excludeIds: new Set([...libraryIds, ...exclude, ...recentIds]),
          filterExplicit: !!opts.filterExplicit,
          artistCap: cfg.artistCap,
          artistSeedCounts: batchArtistSeed,
          lastArtist: lastPlaylistArtist,
          moodArtistCap: 1,
          blockedArtists: cfg.blockedArtists,
          enabledGenres: Array.isArray(genres) ? genres : null,
          bucketsFor: bucketsForArtist,
          preferLane: setLane,
          signal: outsideSignal,
        });
        console.log(
          `[moods] ${activeMoodPack.id}: filled ${discoveries.length}/${similarWant} outside slots from era charts (lane=${setLane} exact) in ${Date.now() - outsideStarted}ms`
        );
      } catch (err) {
        if (outsideSignal.aborted) {
          console.warn(
            `[moods] outside-slot budget ${OUTSIDE_SLOT_BUDGET_MS}ms hit; using ${discoveries.length} era pick(s)`
          );
        } else {
          console.error("[moods] era slot fill failed:", err.message);
        }
      }
    } else if (!showcaseArtistKey && similarWant > 0 && isDiscoveryAvailable()) {
      const discExclude = new Set([...libraryIds, ...exclude, ...recentIds]);
      // Prefer seeds already on the exact lane so Songs Like stays in-family.
      const seeds = [];
      for (const pl of usable) {
        for (const t of pl.tracks || []) {
          let buckets = bucketsForArtistSync(t.artist);
          if (!buckets.length) buckets = ["other"];
          if (fitsExactLane(buckets, setLane)) {
            seeds.push({ artist: t.artist, name: t.name });
          }
        }
      }
      if (!seeds.length) {
        for (const pl of usable) {
          for (const t of pl.tracks || []) {
            seeds.push({ artist: t.artist, name: t.name });
          }
        }
      }
      try {
        discoveries = await getSimilarUris({
          seeds,
          excludeIds: discExclude,
          enabledGenres: Array.isArray(genres) ? genres : null,
          filterExplicit: !!opts.filterExplicit,
          artistCap: cfg.artistCap,
          artistSeedCounts: batchArtistSeed,
          lastArtist: lastPlaylistArtist,
          discoveryArtistCap: 1,
          blockedArtists: cfg.blockedArtists,
          flowState: cfg.flowState,
          count: similarWant,
          preferLane: setLane,
          signal: outsideSignal,
        });
        console.log(
          `[discover] lane=${setLane || "?"} exact got ${discoveries.length}/${similarWant} in ${Date.now() - outsideStarted}ms`
        );
      } catch (err) {
        if (outsideSignal.aborted) {
          console.warn(
            `[discover] outside-slot budget ${OUTSIDE_SLOT_BUDGET_MS}ms hit; using ${discoveries.length} discovery pick(s)`
          );
        } else {
          console.error("[discover] failed:", err.message);
        }
      }
    }

    for (const d of discoveries) {
      const artist = claimBatchArtist(d.artist);
      if (artist) lastPlaylistArtist = artist;
    }
    batchArtistSeed = syncBatchArtistBlocks();

    // If discovery came up short, try more exact-lane playlist picks first.
    const discoveryShortfall = Math.max(0, similarWant - discoveries.length);
    if (discoveryShortfall > 0) {
      cfg.lastArtist = lastPlaylistArtist;
      const fill = pickWithRelaxation(
        usable,
        exclude,
        discoveryShortfall,
        recentIds,
        batchArtistSeed,
        cfg
      );
      for (const uri of fill.uris) {
        playlistUris.push(uri);
        const id = spotifyTrackId(uri);
        if (id) exclude.add(id);
        const artist = claimBatchArtist(artistByUri.get(uri));
        if (artist) lastPlaylistArtist = artist;
      }
      batchArtistSeed = syncBatchArtistBlocks();
      relaxedArtist = relaxedArtist || fill.relaxedArtist;
      relaxedMemory = relaxedMemory || fill.relaxedMemory;
      memoryReuseCount += fill.memoryReuseCount;
    }

    // Still short of the batch target → Spotify / Last.fm exact-lane hits
    // outside the library. Never pad with off-lane tracks.
    {
      const need = Math.max(
        0,
        totalTarget - playlistUris.length - discoveries.length
      );
      if (
        !showcaseArtistKey &&
        need > 0 &&
        setLane &&
        !wasPreempted() &&
        !outsideSignal.aborted
      ) {
        try {
          const hits = await getLaneHits({
            lane: setLane,
            count: need,
            excludeIds: new Set([...libraryIds, ...exclude, ...recentIds]),
            filterExplicit: !!opts.filterExplicit,
            artistCap: cfg.artistCap,
            artistSeedCounts: batchArtistSeed,
            lastArtist: lastPlaylistArtist,
            laneArtistCap: 1,
            blockedArtists: cfg.blockedArtists,
            enabledGenres: Array.isArray(genres) ? genres : null,
            bucketsFor: bucketsForArtist,
            signal: outsideSignal,
          });
          if (hits.length) {
            for (const h of hits) {
              if (h.id) exclude.add(h.id);
              const artist = claimBatchArtist(h.artist);
              if (artist) lastPlaylistArtist = artist;
            }
            discoveries = discoveries.concat(hits);
            laneHitAdded += hits.length;
            batchArtistSeed = syncBatchArtistBlocks();
            console.log(
              `[lane-hits] lane=${setLane} filled ${hits.length}/${need} Spotify exact-lane hit(s) in ${Date.now() - outsideStarted}ms`
            );
          } else {
            console.log(
              `[lane-hits] lane=${setLane} need ${need}; none available (shorten batch)`
            );
          }
        } catch (err) {
          if (outsideSignal.aborted) {
            console.warn(
              `[lane-hits] outside-slot budget ${OUTSIDE_SLOT_BUDGET_MS}ms hit; skipping further fills`
            );
          } else {
            console.error("[lane-hits] shortfall fill failed:", err.message);
          }
        }
      } else if (outsideSignal.aborted && need > 0) {
        console.warn(
          `[lane-hits] skipped; outside-slot budget ${OUTSIDE_SLOT_BUDGET_MS}ms already spent`
        );
      }
    }
  } finally {
    clearTimeout(outsideTimer);
    console.log(
      `[random] outside slots done in ${Date.now() - outsideStarted}ms` +
        ` discoveries=${discoveries.length} laneHits=${laneHitAdded}` +
        (outsideSignal.aborted ? " (budget)" : "")
    );
  }
  console.log(
    `[random] plan ready in ${Date.now() - planStarted}ms` +
      ` playlist=${playlistUris.length} outside=${discoveries.length}`
  );

  // 3) Mix discoveries through playlist picks (always lead with a playlist
  // pick when any exist). Avoid adjacent Songs Like unless discoveries
  // outnumber the available after-track gaps.
  const playlistItems = playlistUris.map((uri) => ({
    uri,
    id: spotifyTrackId(uri),
    artist: artistByUri.get(uri) ?? "",
    name: nameByUri.get(uri) ?? "",
    discovered: false,
  }));
  // Under an era mood the outside-slot picks are chart hits, not Songs Like —
  // they get their own "mood" origin so the UI badges them by era.
  const discoveryItems = discoveries.map((d) => ({
    uri: d.uri,
    id: d.id,
    artist: d.artist ?? "",
    name: d.name ?? "",
    discovered: !activeMoodPack,
    moodPick: !!activeMoodPack,
  }));
  let order = mixPlaylistAndDiscovery(playlistItems, discoveryItems);
  const beforeUnique = order.length;
  order = enforceUniqueArtistsInBatch(order, { allowSameArtist });
  if (order.length < beforeUnique) {
    console.log(
      `[random] dropped ${beforeUnique - order.length} same-artist duplicate(s) from batch`
    );
  }
  // Unique filter can drop playlist separators and clump Songs Like — re-space.
  {
    const base = order.filter((t) => !t.discovered);
    const extra = order.filter((t) => t.discovered);
    if (base.length && extra.length) {
      order = mixPlaylistAndDiscovery(base, extra);
    }
  }
  order = ensurePlaylistLead(order);
  // Re-sync claimed artists from the final order (unique filter may have dropped).
  batchArtists.clear();
  for (const item of order) claimBatchArtist(item.artist);
  batchArtistSeed = syncBatchArtistBlocks();

  const highlightsPreview = order.slice(0, 8).map((t) => ({
    artist: t.artist || "",
    name: t.name || "",
    discovered: !!t.discovered,
  }));

  return {
    count,
    genres,
    opts,
    order,
    usable,
    exclude,
    recentIds,
    cfg,
    batchArtists,
    allowSameArtist,
    lastPlaylistArtist,
    batchArtistSeed,
    blockedArtists,
    totalTarget,
    similarWant,
    setLane,
    activeMoodPack,
    showcaseArtistKey,
    showcaseArtistName,
    firstAppendPosition,
    queueTotalBefore: queueItems.length,
    libraryIds,
    artistByUri,
    nameByUri,
    relaxedArtist,
    relaxedMemory,
    memoryReuseCount,
    laneHitAdded,
    highlightsPreview,
    similarAddedPreview: order.filter((t) => t.discovered).length,
    moodAddedPreview: order.filter((t) => t.moodPick).length,
    preemptGeneration: opts.preemptGeneration,
  };
}

async function enqueueRandomBatchUnlocked(plan, opts = {}) {
  const mergedOpts = { ...(plan?.opts || {}), ...opts };
  const wasPreempted = () =>
    mergedOpts.preemptGeneration != null &&
    queueWorkWasPreempted(mergedOpts.preemptGeneration);

  const count = plan.count;
  const genres = plan.genres;
  const order = Array.isArray(plan.order) ? plan.order : [];
  const usable = plan.usable || [];
  const exclude = plan.exclude instanceof Set ? plan.exclude : new Set();
  const recentIds = plan.recentIds instanceof Set ? plan.recentIds : new Set();
  const cfg = plan.cfg || getRandomnessSettings();
  const batchArtists =
    plan.batchArtists instanceof Set ? plan.batchArtists : new Set();
  const allowSameArtist = !!plan.allowSameArtist;
  let lastPlaylistArtist = plan.lastPlaylistArtist || null;
  let batchArtistSeed = plan.batchArtistSeed;
  const blockedArtists =
    plan.blockedArtists instanceof Set ? plan.blockedArtists : new Set();
  const totalTarget = Number(plan.totalTarget) || order.length;
  const similarWant = Number(plan.similarWant) || 0;
  const setLane = plan.setLane || null;
  const activeMoodPack = plan.activeMoodPack || null;
  const showcaseArtistKey = plan.showcaseArtistKey || null;
  const showcaseArtistName = plan.showcaseArtistName || null;
  const reactionSetKind =
    plan.reactionSetKind === "loved" || plan.reactionSetKind === "hated"
      ? plan.reactionSetKind
      : null;
  const firstAppendPosition = Number(plan.firstAppendPosition) || 1;
  const queueTotalBefore = Number(plan.queueTotalBefore) || 0;
  const libraryIds =
    plan.libraryIds instanceof Set ? plan.libraryIds : new Set();
  const artistByUri = plan.artistByUri || new Map();
  const nameByUri = plan.nameByUri || new Map();
  let relaxedArtist = !!plan.relaxedArtist;
  let relaxedMemory = !!plan.relaxedMemory;
  let memoryReuseCount = Number(plan.memoryReuseCount) || 0;
  let laneHitAdded = Number(plan.laneHitAdded) || 0;

  const claimBatchArtist = (artist) => {
    const a = primaryArtist(artist);
    if (a) batchArtists.add(a);
    return a;
  };
  const syncBatchArtistBlocks = () => {
    if (allowSameArtist) {
      cfg.blockedArtists = blockedArtists;
      return cloneArtistCountMap(artistCountsInWindow(cfg.artistWindow));
    }
    cfg.blockedArtists = new Set([...blockedArtists, ...batchArtists]);
    const seed = cloneArtistCountMap(artistCountsInWindow(cfg.artistWindow));
    for (const a of batchArtists) {
      seed.set(a, Math.max(seed.get(a) ?? 0, cfg.artistCap));
    }
    return seed;
  };

  const m = await getManager();
  const coordinator = await resolveCoordinator(m);
  await ensureOrderedPlayModeOn(coordinator);

  // 4) Enqueue in that order. `added` = total enqueued (playlist + discovery);
  // `similarAdded` is the discovery subset so the UI can badge the mix.
  // Defer Songs Like until a non-Discover track lands so a failed playlist
  // lead cannot leave Discover as Sonos queue #1.
  let added = 0;
  let similarAdded = 0;
  let moodAdded = 0;
  const recorded = [];
  const discoveredIds = [];
  const moodIds = [];
  const fillerIds = [];
  const pendingDiscover = [];
  const hasNonDiscover = order.some((t) => t && !t.discovered);

  async function enqueueOne(item) {
    const meta = MetaDataHelper.GuessMetaDataAndTrackUri(item.uri, resolveRegion());
    await enqueueMeta(m, meta);
    added++;
    if (item.moodPick) {
      moodAdded++;
      if (item.id) moodIds.push(item.id);
    } else if (item.discovered) {
      similarAdded++;
      if (item.id) discoveredIds.push(item.id);
    } else if (item.id) {
      fillerIds.push(item.id);
    }
    if (item.id) recentIds.add(item.id);
    recorded.push({
      id: item.id,
      artist: item.artist,
      name: item.name,
      source: item.moodPick
        ? "mood"
        : item.discovered
          ? "discovered"
          : "filler",
      mood: item.moodPick ? activeMoodPack?.id || null : null,
    });
  }

  for (const item of order) {
    if (wasPreempted()) break;
    if (hasNonDiscover && added === 0 && item.discovered) {
      pendingDiscover.push(item);
      continue;
    }
    try {
      await enqueueOne(item);
    } catch (err) {
      console.error(`[random] failed to add ${item.uri}:`, err.message);
    }
    if (added > 0 && pendingDiscover.length) {
      while (pendingDiscover.length && !wasPreempted()) {
        const d = pendingDiscover.shift();
        try {
          await enqueueOne(d);
        } catch (err) {
          console.error(`[random] failed to add ${d.uri}:`, err.message);
        }
      }
    }
  }
  // All playlist/mood leads failed — still enqueue deferred Discoveries.
  while (pendingDiscover.length && !wasPreempted()) {
    const d = pendingDiscover.shift();
    try {
      await enqueueOne(d);
    } catch (err) {
      console.error(`[random] failed to add ${d.uri}:`, err.message);
    }
  }
  if (recorded.length) recordPlayed(recorded);
  const laneOpts = setLane ? { genreLane: setLane } : {};
  if (discoveredIds.length) markOrigin(discoveredIds, "discovered", laneOpts);
  if (moodIds.length)
    markOrigin(moodIds, "mood", {
      mood: activeMoodPack?.id || null,
      ...laneOpts,
    });
  if (fillerIds.length) {
    markOrigin(fillerIds, "filler", {
      ...laneOpts,
      ...(reactionSetKind ? { reactionSet: reactionSetKind } : {}),
    });
  }
  if (reactionSetKind && fillerIds.length) {
    noteReactionSetPlayed(reactionSetKind, fillerIds);
  }

  // 5) Top up if some enqueues failed (or we are still under totalTarget).
  // Exact-lane playlist leftovers first, then Spotify lane hits — never off-lane.
  // Reaction sets stay reaction-only (no playlist/Discover top-up).
  while (!reactionSetKind && added < totalTarget && !wasPreempted()) {
    batchArtistSeed = syncBatchArtistBlocks();
    cfg.lastArtist = lastPlaylistArtist;
    const more = pickWithRelaxation(
      usable,
      exclude,
      totalTarget - added,
      recentIds,
      batchArtistSeed,
      cfg
    );
    let progressed = false;
    if (more.uris.length) {
      relaxedArtist = relaxedArtist || more.relaxedArtist;
      relaxedMemory = relaxedMemory || more.relaxedMemory;
      memoryReuseCount += more.memoryReuseCount;
      const rec2 = [];
      const filler2 = [];
      for (const uri of more.uris) {
        if (wasPreempted()) break;
        const id = spotifyTrackId(uri);
        const artistName = artistByUri.get(uri) ?? "";
        const artist = primaryArtist(artistName);
        if (
          !allowSameArtist &&
          artist &&
          batchArtists.has(artist)
        ) {
          if (id) exclude.add(id);
          continue;
        }
        exclude.add(id);
        try {
          const meta = MetaDataHelper.GuessMetaDataAndTrackUri(uri, resolveRegion());
          await enqueueMeta(m, meta);
          added++;
          progressed = true;
          claimBatchArtist(artistName);
          if (artist) lastPlaylistArtist = artist;
          if (id) {
            recentIds.add(id);
            filler2.push(id);
          }
          rec2.push({
            id,
            artist: artistName,
            name: nameByUri.get(uri) ?? "",
            source: "filler",
          });
          if (added >= totalTarget) break;
        } catch (err) {
          console.error(`[random] failed to add ${uri}:`, err.message);
        }
      }
      if (rec2.length) recordPlayed(rec2);
      if (filler2.length) markOrigin(filler2, "filler", laneOpts);
    }
    if (added >= totalTarget || wasPreempted()) break;
    if (showcaseArtistKey || !setLane) break;
    batchArtistSeed = syncBatchArtistBlocks();
    let hits = [];
    try {
      hits = await getLaneHits({
        lane: setLane,
        count: totalTarget - added,
        excludeIds: new Set([...libraryIds, ...exclude, ...recentIds]),
        filterExplicit: !!mergedOpts.filterExplicit,
        artistCap: cfg.artistCap,
        artistSeedCounts: batchArtistSeed,
        lastArtist: lastPlaylistArtist,
        laneArtistCap: 1,
        blockedArtists: cfg.blockedArtists,
        enabledGenres: Array.isArray(genres) ? genres : null,
        bucketsFor: bucketsForArtist,
      });
    } catch (err) {
      console.error("[lane-hits] top-up failed:", err.message);
      break;
    }
    if (!hits.length) break;
    const recHits = [];
    const discIds = [];
    for (const h of hits) {
      if (wasPreempted()) break;
      const artist = primaryArtist(h.artist);
      if (!allowSameArtist && artist && batchArtists.has(artist)) {
        if (h.id) exclude.add(h.id);
        continue;
      }
      try {
        const meta = MetaDataHelper.GuessMetaDataAndTrackUri(h.uri, resolveRegion());
        await enqueueMeta(m, meta);
        added++;
        similarAdded++;
        laneHitAdded += 1;
        progressed = true;
        claimBatchArtist(h.artist);
        if (h.id) {
          exclude.add(h.id);
          recentIds.add(h.id);
          discIds.push(h.id);
        }
        if (artist) lastPlaylistArtist = artist;
        recHits.push({
          id: h.id,
          artist: h.artist,
          name: h.name,
          source: "discovered",
        });
        recorded.push({
          id: h.id,
          artist: h.artist || "",
          name: h.name || "",
          discovered: true,
        });
        if (added >= totalTarget) break;
      } catch (err) {
        console.error(`[lane-hits] failed to add ${h.uri}:`, err.message);
      }
    }
    if (recHits.length) recordPlayed(recHits);
    if (discIds.length) markOrigin(discIds, "discovered", laneOpts);
    if (!progressed) break;
  }

  // Era top-up: the mood's promise. When the (era-filtered) playlists ran dry
  // before the batch hit its target, fill the remainder with era chart hits
  // from outside the library. Excludes everything queued this batch plus the
  // song-memory window; the library itself is fair game here (anything still
  // eligible would already have been picked above).
  if (
    !reactionSetKind &&
    !showcaseArtistKey &&
    activeMoodPack &&
    added < totalTarget &&
    !wasPreempted()
  ) {
    try {
      batchArtistSeed = syncBatchArtistBlocks();
      const hits = await getMoodHits({
        mood: activeMoodPack.id,
        count: totalTarget - added,
        excludeIds: new Set([...exclude, ...recentIds]),
        filterExplicit: !!mergedOpts.filterExplicit,
        artistCap: cfg.artistCap,
        artistSeedCounts: batchArtistSeed,
        lastArtist: lastPlaylistArtist,
        moodArtistCap: 1,
        blockedArtists: cfg.blockedArtists,
        enabledGenres: Array.isArray(genres) ? genres : null,
        bucketsFor: bucketsForArtist,
        preferLane: setLane,
      });
      if (hits.length) {
        console.log(
          `[moods] ${activeMoodPack.id}: topping up ${hits.length} era hit(s) — playlists ran dry at ${added}/${totalTarget}`
        );
      }
      const rec3 = [];
      const moodIds3 = [];
      for (const h of hits) {
        if (wasPreempted()) break;
        const artist = primaryArtist(h.artist);
        if (!allowSameArtist && artist && batchArtists.has(artist)) {
          if (h.id) exclude.add(h.id);
          continue;
        }
        try {
          const meta = MetaDataHelper.GuessMetaDataAndTrackUri(h.uri, resolveRegion());
          await enqueueMeta(m, meta);
          added++;
          moodAdded++;
          claimBatchArtist(h.artist);
          if (artist) lastPlaylistArtist = artist;
          if (h.id) {
            exclude.add(h.id);
            recentIds.add(h.id);
            moodIds3.push(h.id);
          }
          rec3.push({
            id: h.id,
            artist: h.artist,
            name: h.name,
            source: "mood",
            mood: activeMoodPack.id,
          });
          if (added >= totalTarget) break;
        } catch (err) {
          console.error(`[moods] failed to add ${h.uri}:`, err.message);
        }
      }
      if (rec3.length) recordPlayed(rec3);
      if (moodIds3.length)
        markOrigin(moodIds3, "mood", {
          mood: activeMoodPack.id,
          ...laneOpts,
        });
    } catch (err) {
      console.error("[moods] era top-up failed:", err.message);
    }
  }

  // Auto-start playback if the system is idle (stopped), resuming the queue in
  // order. Never hijacks an external source (radio/SiriusXM/line-in) or a
  // deliberate pause (see autoStartDecision). When deferAutoStart is set (DJ
  // voice), we only report that we WOULD have started so the caller can announce
  // first, then Play.
  let started = false;
  let deferredStart = false;
  if (added > 0 && !wasPreempted()) {
    if (mergedOpts.deferAutoStart) {
      try {
        const transport = await coordinator.AVTransportService.GetTransportInfo();
        if (autoStartDecision(transport.CurrentTransportState) === "start") {
          deferredStart = true;
          await holdIdleForDeferredShout(coordinator);
        }
      } catch {
        deferredStart = false;
      }
    } else {
      started = await autoStartIfIdle(coordinator);
    }
  }

  // Skip cooldowns tick down by how many songs we actually added this batch.
  if (added > 0) tickArtistCooldowns(added);

  // Remember this set's lane so the next Random / Never-Ending batch rotates.
  if (added > 0 && setLane) recordGenreLane(setLane);

  if (added > 0) invalidateSonosSnapshots();

  // First few tracks for DJ voice copy (artist/title + discovery flag).
  const highlights = recorded.slice(0, 8).map((t) => ({
    artist: t.artist || "",
    name: t.name || "",
    discovered: !!t.discovered,
  }));

  if (added > 0) {
    if (reactionSetKind) {
      noteReactionSetBuilt({ kind: reactionSetKind });
      noteRandomSetBuilt({ wasShowcase: false });
    } else if (showcaseArtistKey) {
      noteRandomSetBuilt({ wasShowcase: true });
      noteReactionSetBuilt({ kind: null });
    } else {
      noteRandomSetBuilt({ wasShowcase: false });
      noteReactionSetBuilt({ kind: null });
    }
  }

  if (added > 0) {
    const short = Math.max(0, totalTarget - added);
    console.log(
      `[random] genre lane=${setLane || "?"} exact ` +
        `playlist=${added - similarAdded - moodAdded} ` +
        `discover=${similarAdded} laneHits=${laneHitAdded}` +
        (activeMoodPack ? ` mood=${activeMoodPack.id} (${moodAdded} era hits)` : "") +
        (showcaseArtistKey ? ` showcase=${showcaseArtistName}` : "") +
        (reactionSetKind ? ` reactionSet=${reactionSetKind}` : "") +
        (short ? ` short=${short}` : "")
    );
  }

  return {
    requested: count,
    batchTarget: totalTarget,
    added,
    started,
    deferredStart,
    firstAppendPosition,
    queueTotalBefore,
    highlights,
    similarRequested: similarWant,
    similarAdded,
    mood: reactionSetKind ? null : activeMoodPack?.id ?? null,
    moodAdded,
    relaxedArtist,
    relaxedMemory,
    memoryReuseCount,
    genreLane: reactionSetKind ? null : setLane,
    reactionSet: reactionSetKind ? { kind: reactionSetKind } : null,
    sameArtistBatch: showcaseArtistKey
      ? {
          artist: showcaseArtistName,
          key: showcaseArtistKey,
          hostArmed: false,
        }
      : null,
    preempted: wasPreempted(),
  };
}
