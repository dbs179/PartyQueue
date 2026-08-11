// Queue routes: guest add (with request fairness + DJ shouts), dedications,
// playlist/Random adds, the Random picker helpers (genres, pool size,
// Never-Ending autofill, selection), and host queue editing.

import { asyncHandler } from "../http/async-handler.js";
import {
  preemptQueueWork,
  queueWorkGeneration,
  queueWorkWasPreempted,
} from "../queue-preempt.js";
import {
  isUserConnected,
  getArtistTopTracks,
  getArtist,
} from "../spotify.js";
import {
  getAutoFillState,
  getClosingTimeAt,
  markClosingTime,
  setAutoFill,
  savePickerSelection,
  clearQueueWithoutAutoRefill,
} from "../autofill.js";
import {
  isEndOfNightTrack,
  shouldAnnouncePartyRecap,
} from "../closing-time.js";
import { buildPartyRecap } from "../party-recap.js";
import { shouldShoutOnSearch, announceRequestShout } from "../dj-shout.js";
import {
  GENRE_BUCKETS,
  GENRE_TAG_GUIDE,
  GENRE_TAG_RULES,
  genreCounts,
  eligiblePoolSize,
  isGenreDataEnabled,
} from "../genres.js";
import { moodGenreGuide } from "../genre-presets.js";
import { normalizeMood, moodPack } from "../moods.js";
import {
  getRandomnessSettings,
  getDiscoverySettings,
  getRequestFairnessSettings,
  getSetRequestFairnessSettings,
  getFairnessResetAt,
  getContentSettings,
  getRotationSettings,
} from "../settings.js";
import {
  announceFreshSet,
  announceSetBatch,
  announcePartyRecap,
  isDjVoiceReady,
  prepareSetAnnounceClip,
} from "../dj-voice.js";
import {
  extractHostToken,
  isValidHostToken,
} from "../host-auth.js";
import {
  requestedByOf,
  requestedByUserOf,
  setDedication,
} from "../queue-origin.js";
import {
  resolveGuestIdentity,
  sanitizeDedication,
  sanitizeDisplayName,
} from "../display-name.js";
import { ensureGuestProfile } from "../guest-profiles.js";
import {
  recordRequest,
  recordSetRequest,
  getRequests,
  setRequestDedication,
} from "../request-log.js";
import {
  evaluateRequestFairness,
  withRequestFairnessLock,
} from "../request-fairness.js";
import { evaluateSetRequestFairness } from "../set-request-fairness.js";
import { buildGuestFairnessStatus } from "../guest-fairness-status.js";
import { spotifyTrackId } from "../sampler.js";
import {
  addPlaylistToQueue,
  addRandomFromPlaylists,
  planRandomFromPlaylists,
  enqueueRandomBatch,
  addTrackToQueue,
  addSetRequestToQueue,
  SET_REQUEST_SIZE,
  getQueueList,
  invalidateSonosSnapshots,
  shouldClearQueueForRandomDj,
  randomDjAnnouncePlan,
  play,
  removeQueueTrack,
  removeUpcomingFillerTracks,
  reorderQueueTrack,
  ensureShoutLeadBuffer,
} from "../sonos.js";
import {
  setPartyOver,
  isPartyOver,
  PARTY_OVER_MESSAGE,
} from "../party-rituals.js";
import { requireHostControls } from "../http/host-controls.js";
import { nudgeNowPlayingStream } from "../now-playing-http.js";
import { nudgePartySettingsStream } from "../party-settings-http.js";

/** @param {import('express').Express} app @param {import('./api.js').ApiCtx} ctx */
export function registerQueueRoutes(app, ctx) {
  const { queueBurstLimit, queueSustainedLimit, destructiveLimit } = ctx;

  // Speaker-layer seam: production uses ../sonos.js (and autofill's clear);
  // tests inject fakes via ctx.sonos to cover happy paths without a live
  // speaker. DJ-voice-only calls (getQueueStatus, clearQueue,
  // findUpcomingTrackPosition) stay dynamic imports — they never run unless
  // DJ Voice is configured.
  const sonos = {
    addTrackToQueue,
    addSetRequestToQueue,
    addPlaylistToQueue,
    addRandomFromPlaylists,
    planRandomFromPlaylists,
    enqueueRandomBatch,
    getQueueList,
    removeQueueTrack,
    removeUpcomingFillerTracks,
    reorderQueueTrack,
    play,
    invalidateSonosSnapshots,
    clearQueueWithoutAutoRefill,
    ensureShoutLeadBuffer,
    ...(ctx.sonos || {}),
  };

  app.post("/api/queue", queueBurstLimit, queueSustainedLimit, asyncHandler(async (req, res) => {
    const preemptGeneration = queueWorkGeneration();
    const { uri, name, artist, force, requestedBy, requestedByUser, dedication } =
      req.body ?? {};
    if (!uri) {
      return res.status(400).json({ error: "Missing track uri." });
    }
    if (isPartyOver()) {
      return res.status(403).json({ error: PARTY_OVER_MESSAGE, code: "party_over" });
    }
    if (getContentSettings().requestsPaused) {
      return res.status(403).json({ error: "Requests are paused right now." });
    }
    const { user, badge, alias } = resolveGuestIdentity({
      requestedBy,
      requestedByUser,
    });
    if (!user) {
      return res.status(400).json({ error: "Enter your name before adding a song." });
    }
    const note = sanitizeDedication(dedication);
    try {
      const outcome = await withRequestFairnessLock(async () => {
        const fairness = getRequestFairnessSettings();
        const queueSnapshot = fairness.requestFairnessEnabled
          ? await sonos.getQueueList()
          : { tracks: [] };
        const decision = evaluateRequestFairness({
          settings: fairness,
          user,
          queue: Array.isArray(queueSnapshot)
            ? queueSnapshot
            : queueSnapshot?.tracks || [],
          events: getRequests(),
          target: { uri, name, artist },
          force: !!force,
          hostAuthenticated: isValidHostToken(extractHostToken(req)),
          fairnessResetAt: getFairnessResetAt(),
        });
        if (!decision.allowed) return { decision };

        const added = await sonos.addTrackToQueue(uri, {
          name,
          artist,
          force: !!force,
          requestedBy: badge,
          requestedByUser: user,
          dedication: note,
        });

        // Only a newly-added or promoted queue slot consumes rolling fairness
        // quota and Party Stats. Repeating an existing request is idempotent.
        const reqId = spotifyTrackId(uri);
        if (reqId && added.requestCreated !== false) {
          recordRequest({
            id: reqId,
            name,
            artist,
            requestedBy: user,
            alias: alias && alias !== user ? alias : null,
            dedication: note,
          });
        }
        return { result: added };
      });

      if (outcome.decision) {
        const denied = outcome.decision;
        if (denied.retryAfterSec) {
          res.set("Retry-After", String(denied.retryAfterSec));
        }
        return res.status(denied.status || 429).json({
          error: denied.error,
          code: denied.code,
          totalRequestedUpcoming: denied.totalRequestedUpcoming,
          upcomingThreshold: denied.upcomingThreshold,
          upcomingCount: denied.upcomingCount,
          upcomingCap: denied.upcomingCap,
          rollingCount: denied.rollingCount,
          rollingMax: denied.rollingMax,
          retryAt: denied.retryAt,
        });
      }

      const result = outcome.result;
      const reqId = spotifyTrackId(uri);

      // First request under a new name → add them to the Users list so the
      // host can attach shout-out notes without typing the name by hand.
      try {
        if (ensureGuestProfile(user)) {
          console.log(`[queue] new guest profile created: ${user}`);
        }
      } catch (err) {
        console.error("[queue] guest profile create:", err.message);
      }

      // House ritual: hand-adding the End of Night song signals last call. We
      // announce it to everyone (via the Now Playing poll), switch off the
      // Never-Ending Queue, flip on the Party's Over lockdown, and clear
      // upcoming filler (Random / Discover / era hits) so only real requests
      // play out the night. Optional Party Summary TTS is inserted before
      // that song.
      let closingTime = false;
      let partyRecap = null;
      if (
        result.requestCreated !== false &&
        isEndOfNightTrack({ uri, name, artist })
      ) {
        // Cancel any in-flight Never-Ending / Random fill before disabling the
        // monitor — setAutoFill(false) clears the timer but does not bump the
        // preempt generation, so a tick already past its enabled check could
        // still append filler after last call (Clear Queue always preempts).
        preemptQueueWork();
        if (getAutoFillState().enabled) setAutoFill(false);
        setPartyOver(true);
        // Filler removals above shift the just-added song up; removedBefore
        // keeps the recap announce pointed at its live position.
        let removedBefore = 0;
        try {
          const cleared = await sonos.removeUpcomingFillerTracks({
            beforePosition:
              Number(result.absoluteQueuePosition ?? result.queuePosition) || 0,
          });
          removedBefore = cleared.removedBefore || 0;
        } catch (err) {
          console.error("[queue] closing-time filler clear:", err.message);
        }
        partyRecap = buildPartyRecap();
        markClosingTime(partyRecap);
        closingTime = true;
        const posRaw = Number(
          result.absoluteQueuePosition ?? result.queuePosition
        );
        const pos = Number.isFinite(posRaw) ? posRaw - removedBefore : posRaw;
        if (
          shouldAnnouncePartyRecap() &&
          isDjVoiceReady() &&
          Number.isFinite(pos) &&
          pos >= 1
        ) {
          void announcePartyRecap(partyRecap, {
            queuePosition: pos,
            preemptGeneration,
          }).catch(
            (err) => console.error("[queue] party recap announce:", err.message)
          );
        }
      } else if (
        result.requestCreated !== false &&
        shouldShoutOnSearch({
          force: !!result.queueWasEmpty,
          requestedBy: user,
        })
      ) {
        // Mood Pulse: occasional DJ shout on search adds. Empty queue always
        // shouts when enabled (and starts playback from the TTS clip).
        // Speak/key off User (real name), never the queue alias.
        const pos = Number(result.absoluteQueuePosition ?? result.queuePosition);
        const startPlayback = !!(result.queueWasEmpty || result.deferredStart);
        if (Number.isFinite(pos) && pos >= 1) {
          if (startPlayback) {
            // Await empty/idle shouts so we can fall back to playing the song if
            // TTS/HA fails — otherwise the queue stays STOPPED forever.
            try {
              const voice = await announceRequestShout({
                name,
                artist,
                requestedBy: user,
                dedication: note,
                uri,
                trackId: reqId,
                queuePosition: pos,
                startPlayback: true,
                preemptGeneration,
              });
              if (
                !voice?.ok &&
                !voice?.skipped &&
                !queueWorkWasPreempted(preemptGeneration)
              ) {
                await sonos.play({ trackNumber: 1 });
              }
            } catch (err) {
              console.error("[queue] request shout:", err.message);
              if (!queueWorkWasPreempted(preemptGeneration)) {
                try {
                  await sonos.play({ trackNumber: 1 });
                } catch (playErr) {
                  console.error("[queue] shout fallback play:", playErr.message);
                }
              }
            }
          } else {
            // Mid-set request: await TTS insert so the playhead can't race past
            // the shout. When next-up with little time left, demote behind one
            // non-request track first (music keeps playing). Last-song / no
            // buffer still uses the imminent pause inside announceOnSonos.
            try {
              let shoutPos = pos;
              try {
                const lead = await sonos.ensureShoutLeadBuffer(pos);
                if (Number.isFinite(lead?.absoluteQueuePosition)) {
                  shoutPos = lead.absoluteQueuePosition;
                }
              } catch (err) {
                console.warn(
                  "[queue] shout lead buffer skipped:",
                  err.message
                );
              }
              await announceRequestShout({
                name,
                artist,
                requestedBy: user,
                dedication: note,
                uri,
                trackId: reqId,
                queuePosition: shoutPos,
                startPlayback: false,
                preemptGeneration,
              });
            } catch (err) {
              console.error("[queue] request shout:", err.message);
            }
          }
        }
      } else if (
        result.requestCreated !== false &&
        result.deferredStart &&
        !result.started &&
        !queueWorkWasPreempted(preemptGeneration)
      ) {
        // Shout was deferred-start but didn't fire (DJ not ready, etc.) — play song.
        void sonos.play({ trackNumber: 1 }).catch((err) =>
          console.error("[queue] deferred start failed:", err.message)
        );
      }

      if (closingTime) {
        nudgePartySettingsStream();
        nudgeNowPlayingStream();
      }
      res.json({
        ok: true,
        ...result,
        closingTime,
        closingTimeAt: closingTime ? getClosingTimeAt() : 0,
        partyRecap,
      });
    } catch (err) {
      console.error("[queue]", err.message);
      res.status(502).json({ error: err.message || "Could not add to Sonos queue." });
    }
  }));

  // Guest Set Request: enqueue up to 5 Spotify top tracks for an artist as one
  // contiguous searched block (after existing requests). Separate fairness.
  app.post(
    "/api/queue/set-request",
    queueBurstLimit,
    queueSustainedLimit,
    asyncHandler(async (req, res) => {
      const preemptGeneration = queueWorkGeneration();
      const { artistId, artist, requestedBy, requestedByUser } = req.body ?? {};
      const id = String(artistId || "").trim();
      if (!id) {
        return res.status(400).json({ error: "Pick an artist for a Set Request." });
      }
      if (isPartyOver()) {
        return res
          .status(403)
          .json({ error: PARTY_OVER_MESSAGE, code: "party_over" });
      }
      if (getContentSettings().requestsPaused) {
        return res
          .status(403)
          .json({ error: "Requests are paused right now." });
      }
      const { user, badge, alias } = resolveGuestIdentity({
        requestedBy,
        requestedByUser,
      });
      if (!user) {
        return res
          .status(400)
          .json({ error: "Enter your name before requesting a set." });
      }

      try {
        const fairnessArgs = () => ({
          settings: getSetRequestFairnessSettings(),
          user,
          events: getRequests(),
          hostAuthenticated: isValidHostToken(extractHostToken(req)),
          fairnessResetAt: getFairnessResetAt(),
        });

        // Short lock: check quota only. Spotify I/O must not hold the shared
        // fairness lock — it also serializes regular guest song adds.
        const precheck = await withRequestFairnessLock(async () => {
          const decision = evaluateSetRequestFairness(fairnessArgs());
          return decision.allowed ? { ok: true } : { decision };
        });
        if (precheck.decision) {
          const denied = precheck.decision;
          if (denied.retryAfterSec) {
            res.set("Retry-After", String(denied.retryAfterSec));
          }
          return res.status(denied.status || 429).json({
            error: denied.error,
            code: denied.code,
            rollingCount: denied.rollingCount,
            rollingMax: denied.rollingMax,
            windowMinutes: denied.windowMinutes,
            retryAt: denied.retryAt,
          });
        }

        let artistName = String(artist || "").trim();
        if (!artistName) {
          const resolved = await getArtist(id);
          artistName = resolved?.name || id;
        }

        const filterExplicit = !!getContentSettings().filterExplicit;
        let top = await getArtistTopTracks(id, { filterExplicit });
        top = top.slice(0, SET_REQUEST_SIZE);
        if (!top.length) {
          return res.status(404).json({
            error: `No playable tracks found for ${artistName}.`,
          });
        }

        // Re-check + enqueue + ledger under one short lock (no double-spend).
        const outcome = await withRequestFairnessLock(async () => {
          const decision = evaluateSetRequestFairness(fairnessArgs());
          if (!decision.allowed) return { decision };

          const added = await sonos.addSetRequestToQueue(top, {
            requestedBy: badge,
            requestedByUser: user,
          });

          if (added.requestCreated !== false) {
            recordSetRequest({
              artistId: id,
              artist: artistName,
              requestedBy: user,
              alias: alias && alias !== user ? alias : null,
              tracks: (added.tracks || []).map((t) => ({
                id: t.id,
                name: t.name,
                artist: t.artist,
              })),
            });
          }

          return { result: added, artistName };
        });

        if (outcome.decision) {
          const denied = outcome.decision;
          if (denied.retryAfterSec) {
            res.set("Retry-After", String(denied.retryAfterSec));
          }
          return res.status(denied.status || 429).json({
            error: denied.error,
            code: denied.code,
            rollingCount: denied.rollingCount,
            rollingMax: denied.rollingMax,
            windowMinutes: denied.windowMinutes,
            retryAt: denied.retryAt,
          });
        }

        const result = outcome.result;
        try {
          if (ensureGuestProfile(user)) {
            console.log(`[queue/set-request] new guest profile: ${user}`);
          }
        } catch (err) {
          console.error("[queue/set-request] guest profile:", err.message);
        }

        // One shout for the set (first track), not five. Always shout when
        // enabled — a Set Request is its own set moment, not a random every-N
        // search add (and must not lose to a pending Random refill announce).
        const first = result.tracks?.[0];
        if (
          result.requestCreated !== false &&
          first &&
          shouldShoutOnSearch({
            force: true,
            requestedBy: user,
          })
        ) {
          const pos = Number(
            result.absoluteQueuePosition ?? result.queuePosition
          );
          const startPlayback = !!(result.queueWasEmpty || result.deferredStart);
          if (Number.isFinite(pos) && pos >= 1) {
            try {
              let shoutPos = pos;
              if (!startPlayback) {
                try {
                  const lead = await sonos.ensureShoutLeadBuffer(pos);
                  if (Number.isFinite(lead?.absoluteQueuePosition)) {
                    shoutPos = lead.absoluteQueuePosition;
                  }
                } catch (err) {
                  console.warn(
                    "[queue/set-request] shout lead buffer skipped:",
                    err.message
                  );
                }
              }
              const voice = await announceRequestShout({
                name: first.name || "Set Request",
                artist: artistName,
                requestedBy: user,
                uri: first.uri,
                trackId: first.id,
                queuePosition: shoutPos,
                startPlayback,
                preemptGeneration,
              });
              if (
                startPlayback &&
                !voice?.ok &&
                !voice?.skipped &&
                !queueWorkWasPreempted(preemptGeneration)
              ) {
                await sonos.play({ trackNumber: 1 });
              }
            } catch (err) {
              console.error("[queue/set-request] shout:", err.message);
              if (
                startPlayback &&
                !queueWorkWasPreempted(preemptGeneration)
              ) {
                try {
                  await sonos.play({ trackNumber: 1 });
                } catch (playErr) {
                  console.error(
                    "[queue/set-request] shout fallback play:",
                    playErr.message
                  );
                }
              }
            }
          }
        } else if (
          result.requestCreated !== false &&
          result.deferredStart &&
          !result.started &&
          !queueWorkWasPreempted(preemptGeneration)
        ) {
          void sonos.play({ trackNumber: 1 }).catch((err) =>
            console.error("[queue/set-request] deferred start:", err.message)
          );
        }

        res.json({
          ok: true,
          artist: artistName,
          artistId: id,
          ...result,
        });
      } catch (err) {
        console.error("[queue/set-request]", err.message);
        res
          .status(502)
          .json({ error: err.message || "Could not add Set Request." });
      }
    })
  );

  // Optional post-Add / Up Next dedication. Guest-accessible; only the
  // requester may update their searched origin. If a mid-queue shout pad is
  // still upcoming, supersede it so the DJ can say “goes out to …”.
  app.post("/api/queue/dedication", asyncHandler(async (req, res) => {
    const preemptGeneration = queueWorkGeneration();
    const { uri, dedication, name, artist, requestedBy, requestedByUser } =
      req.body ?? {};
    const id = spotifyTrackId(uri);
    if (!id) {
      return res.status(400).json({ error: "Missing track uri." });
    }
    const identity = resolveGuestIdentity({ requestedBy, requestedByUser });
    if (!identity.user) {
      return res.status(400).json({ error: "Your name is required to dedicate." });
    }
    const updated = setDedication(id, dedication, {
      requestedBy: identity.badge,
      requestedByUser: identity.user,
    });
    if (!updated.ok) {
      return res.status(400).json({ error: updated.error });
    }

    const forWho = updated.dedication;
    // Keep the request-log wall in sync with toast Dedicate.
    setRequestDedication(id, forWho);

    if (forWho && isDjVoiceReady() && name) {
      const by = identity.user || requestedByUserOf(id) || requestedByOf(id);
      try {
        const { findUpcomingTrackPosition } = await import("../sonos.js");
        const pos = await findUpcomingTrackPosition({ name, artist });
        if (pos != null && pos >= 1) {
          void (async () => {
            let shoutPos = pos;
            try {
              const lead = await sonos.ensureShoutLeadBuffer(pos);
              if (Number.isFinite(lead?.absoluteQueuePosition)) {
                shoutPos = lead.absoluteQueuePosition;
              }
            } catch (err) {
              console.warn(
                "[queue] dedication shout lead buffer skipped:",
                err.message
              );
            }
            await announceRequestShout({
              name,
              artist,
              requestedBy: by,
              dedication: forWho,
              uri,
              trackId: id,
              queuePosition: shoutPos,
              startPlayback: false,
              preemptGeneration,
            });
          })().catch((err) =>
            console.error("[queue] dedication shout refresh:", err.message)
          );
        }
      } catch (err) {
        console.warn("[queue] dedication shout refresh skipped:", err.message);
      }
    }
    sonos.invalidateSonosSnapshots();

    res.json({ ok: true, dedication: forWho });
  }));

  app.post("/api/queue/playlist", queueBurstLimit, queueSustainedLimit, asyncHandler(async (req, res) => {
    const { uri } = req.body ?? {};
    if (!uri) {
      return res.status(400).json({ error: "Missing playlist uri." });
    }
    try {
      const result = await sonos.addPlaylistToQueue(uri);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[queue/playlist]", err.message);
      res.status(502).json({ error: err.message || "Could not add playlist to Sonos queue." });
    }
  }));

  function parseCount(raw) {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 1) return 50;
    return Math.min(100, n);
  }

  app.post("/api/queue/random", destructiveLimit, asyncHandler(async (req, res) => {
    const preemptGeneration = queueWorkGeneration();
    if (!isUserConnected()) {
      return res.status(400).json({ error: "Connect your Spotify account first." });
    }
    const { playlistIds, count, genres, mood } = req.body ?? {};
    const ids = Array.isArray(playlistIds) ? playlistIds : null;
    const genreIds = Array.isArray(genres) ? genres : null;
    const moodId = normalizeMood(mood);
    const { discoverEnabled, similarCount } = getDiscoverySettings();
    const { filterExplicit } = getContentSettings();
    const djReady = isDjVoiceReady();
    try {
      // Empty-queue + DJ: clear (no-op wipe + Stop) so the playhead resets before
      // a fresh-set announce owns position 1. Never clear when anything is already
      // queued — guest requests must survive Random (older logic cleared on any
      // !isPlaying / !playingFromQueue, which wiped requests during DJ pauses).
      let clearForDj = false;
      if (djReady) {
        try {
          const { getQueueStatus } = await import("../sonos.js");
          const status = await getQueueStatus();
          clearForDj = shouldClearQueueForRandomDj(status);
          if (!clearForDj && status.total > 0) {
            console.log(
              `[queue/random] skip DJ clear — queue has ${status.total} track(s)` +
                ` (playing=${!!status.isPlaying}, fromQueue=${!!status.playingFromQueue})`
            );
          }
        } catch {
          clearForDj = false;
        }
      }

      if (djReady && clearForDj) {
        try {
          console.log("[queue/random] clearing empty queue for DJ fresh-set start");
          const { clearQueue } = await import("../sonos.js");
          await clearQueue();
        } catch (err) {
          console.error("[queue/random] DJ clear failed:", err.message);
        }
      }

      const randomOpts = {
        similarCount: discoverEnabled ? similarCount : 0,
        filterExplicit,
        deferAutoStart: djReady,
        preemptGeneration,
        mood: moodId,
      };
      const batchPlan = await sonos.planRandomFromPlaylists(
        parseCount(count),
        ids,
        genreIds,
        randomOpts
      );

      // Overlap OpenAI script + TTS with Sonos enqueue when DJ will likely shout.
      const likelyFresh =
        !!clearForDj || (Number(batchPlan.queueTotalBefore) || 0) === 0;
      const plannedCount = Array.isArray(batchPlan.order)
        ? batchPlan.order.length
        : 0;
      let prepPromise = null;
      if (djReady && plannedCount > 0) {
        prepPromise = prepareSetAnnounceClip(
          {
            event: likelyFresh ? "session_start" : "session_refill",
            count: plannedCount,
            added: plannedCount,
            highlights: batchPlan.highlightsPreview ?? [],
            similarAdded: batchPlan.similarAddedPreview ?? 0,
          },
          { preemptGeneration }
        );
      }

      const result = await sonos.enqueueRandomBatch(batchPlan, randomOpts);

      // Fresh idle Random: set announce at #1 + Play. Mid-party Random: set
      // announce immediately before the new batch (under guest requests) — never
      // only when deferredStart (that skipped announce while music was playing).
      const announcePlan = randomDjAnnouncePlan({
        djReady,
        added: result.added,
        queueTotalBefore: result.queueTotalBefore,
        clearForDj,
        deferredStart: result.deferredStart,
        firstAppendPosition: result.firstAppendPosition,
      });
      const willAnnounce = announcePlan.action !== "none";

      // Return as soon as songs are queued — DJ announce continues in background.
      res.json({
        ok: true,
        ...result,
        announced: false,
        announcing: willAnnounce,
      });

      if (!willAnnounce) return;

      void (async () => {
        let prepared = null;
        if (prepPromise) {
          try {
            prepared = await prepPromise;
          } catch (err) {
            console.error("[queue/random] announce prep failed:", err.message);
          }
        }
        if (queueWorkWasPreempted(preemptGeneration)) return;

        if (announcePlan.action === "fresh_set") {
          try {
            const voice = await announceFreshSet(result, {
              preemptGeneration,
              prepared,
            });
            if (voice?.ok) {
              result.started = true;
            } else if (!queueWorkWasPreempted(preemptGeneration)) {
              await sonos.play({ trackNumber: 1 });
              result.started = true;
            }
          } catch (err) {
            console.error("[queue/random] DJ announce failed:", err.message);
            if (queueWorkWasPreempted(preemptGeneration)) {
              result.preempted = true;
            } else {
              try {
                await sonos.play({ trackNumber: 1 });
                result.started = true;
              } catch (playErr) {
                console.error(
                  "[queue/random] fallback play failed:",
                  playErr.message
                );
              }
            }
          }
        } else if (announcePlan.action === "before_batch") {
          try {
            await announceSetBatch(result, {
              queuePosition: announcePlan.queuePosition,
              startPlayback: false,
              event: "session_refill",
              preemptGeneration,
              prepared,
            });
            if (
              announcePlan.resumePlay &&
              !queueWorkWasPreempted(preemptGeneration)
            ) {
              // Leftover queue was STOPPED — resume without seeking to the
              // bottom announce (guest requests at the front stay first).
              await sonos.play();
              result.started = true;
            }
          } catch (err) {
            console.error(
              "[queue/random] mid-queue set announce failed:",
              err.message
            );
            if (
              announcePlan.resumePlay &&
              !queueWorkWasPreempted(preemptGeneration)
            ) {
              try {
                await sonos.play();
                result.started = true;
              } catch (playErr) {
                console.error(
                  "[queue/random] resume play failed:",
                  playErr.message
                );
              }
            }
          }
        }
      })();
    } catch (err) {
      console.error("[queue/random]", err.message);
      res.status(502).json({ error: err.message || "Could not add random songs." });
    }
  }));

  // Available genre buckets plus how many pool songs fall in each, for the UI's
  // genre toggles. `enabled` reports whether a Last.fm key is configured (when
  // off, every song is "Other" and filtering is effectively a no-op).
  // Optional `?playlistIds=a,b,c` scopes chip counts to the host's selection.
  app.get("/api/genres", asyncHandler(async (req, res) => {
    try {
      const raw = req.query?.playlistIds;
      const playlistIds =
        typeof raw === "string" && raw.trim()
          ? raw.split(",").map((s) => s.trim()).filter(Boolean)
          : null;
      const genreLabelById = new Map(GENRE_BUCKETS.map((b) => [b.id, b.label]));
      res.json({
        enabled: isGenreDataEnabled(),
        buckets: GENRE_BUCKETS,
        tagGuide: GENRE_TAG_GUIDE,
        tagRules: GENRE_TAG_RULES,
        moodGuide: moodGenreGuide((id) => genreLabelById.get(id) || id),
        counts: await genreCounts({ playlistIds }),
      });
    } catch (err) {
      console.error("[genres]", err.message);
      res.status(500).json({ error: err.message || "Could not load genres." });
    }
  }));

  // How many unique tracks Random would draw from with the given filters. Powers
  // the pool-size hint under the genre chips. Also returns per-genre counts for
  // the same playlist scope so chip numbers stay in sync with the selection.
  app.post("/api/pool-size", asyncHandler(async (req, res) => {
    try {
      const { playlistIds, genres, mood } = req.body ?? {};
      const ids = Array.isArray(playlistIds) ? playlistIds : null;
      const size = await eligiblePoolSize({
        playlistIds: ids,
        genres: Array.isArray(genres) ? genres : null,
        years: moodPack(mood)?.years ?? null,
      });
      const counts = await genreCounts({ playlistIds: ids });
      const { songMemory } = getRandomnessSettings();
      res.json({
        ok: true,
        ...size,
        counts,
        songMemory,
        // Soft warning thresholds: under memory size, or under ~10x a typical
        // Random-25 batch, repeats / relaxation become likely.
        warn: size.tracks > 0 && (size.tracks < songMemory || size.tracks < 250),
      });
    } catch (err) {
      console.error("[pool-size]", err.message);
      res.status(500).json({ error: err.message || "Could not measure pool size." });
    }
  }));

  // "Never-Ending Queue": auto-tops up the queue with random songs when it runs
  // low. State is server-side so it works with no browser open.
  app.get("/api/autofill", (_req, res) => {
    // discoverEnabled + rotation switches ride along: this endpoint is public
    // and fetched at boot on every view, so those toggles reflect server truth
    // even when the host-gated /api/settings is locked (sessions reset on
    // deploy).
    const rotation = getRotationSettings();
    const content = getContentSettings();
    res.json({
      ...getAutoFillState(),
      discoverEnabled: getDiscoverySettings().discoverEnabled,
      randomMoodEnabled: rotation.randomMoodEnabled,
      randomDecadeEnabled: rotation.randomDecadeEnabled,
      filterExplicit: !!content.filterExplicit,
      kidsLock: !!content.kidsLock,
    });
  });

  app.post("/api/autofill", (req, res) => {
    try {
      const { enabled, playlistIds, genres, mood } = req.body ?? {};
      if (enabled && !isUserConnected()) {
        return res.status(400).json({ error: "Connect your Spotify account first." });
      }
      const ids = Array.isArray(playlistIds) ? playlistIds : undefined;
      const genreIds = Array.isArray(genres) ? genres : undefined;
      // `mood` absent = unchanged; null (or unknown id) = clear.
      const state = setAutoFill(!!enabled, ids, genreIds, mood);
      nudgePartySettingsStream();
      res.json({ ok: true, ...state });
    } catch (err) {
      console.error("[autofill]", err.message);
      res.status(500).json({ error: err.message || "Could not save Never-Ending setting." });
    }
  });

  // Persist playlist + genre selection for Random / Never-Ending even when the
  // monitor is off, so every phone and the server share one host selection.
  app.post("/api/selection", (req, res) => {
    try {
      const { playlistIds, genres, mood } = req.body ?? {};
      const ids = Array.isArray(playlistIds) ? playlistIds : undefined;
      const genreIds = Array.isArray(genres) ? genres : undefined;
      const saved = savePickerSelection(ids, genreIds, mood);
      // Broadcast so Party Display / Vibe mix labels update live.
      nudgePartySettingsStream();
      res.json({ ok: true, ...saved });
    } catch (err) {
      console.error("[selection]", err.message);
      res.status(500).json({ error: err.message || "Could not save selection." });
    }
  });

  app.get("/api/queue/list", asyncHandler(async (_req, res) => {
    try {
      res.json({ tracks: await sonos.getQueueList() });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  }));

  // Guest quota snapshot for the search-bar remaining line. Open on the LAN
  // like POST /api/queue — keyed by User name, not a secret.
  app.get("/api/fairness", asyncHandler(async (req, res) => {
    const user = sanitizeDisplayName(
      typeof req.query?.user === "string"
        ? req.query.user
        : typeof req.query?.requestedByUser === "string"
          ? req.query.requestedByUser
          : ""
    );
    const songSettings = getRequestFairnessSettings();
    const setSettings = getSetRequestFairnessSettings();
    let queue = [];
    if (songSettings.requestFairnessEnabled) {
      try {
        const snapshot = await sonos.getQueueList();
        queue = Array.isArray(snapshot) ? snapshot : snapshot?.tracks || [];
      } catch {
        queue = [];
      }
    }
    res.json(
      buildGuestFairnessStatus({
        user,
        songSettings,
        setSettings,
        queue,
        events: getRequests(),
        fairnessResetAt: getFairnessResetAt(),
      })
    );
  }));

  app.post("/api/queue/remove", destructiveLimit, requireHostControls, asyncHandler(async (req, res) => {
    const { uri, position } = req.body ?? {};
    if (!uri) return res.status(400).json({ error: "Missing track uri." });
    try {
      res.json({ ok: true, ...(await sonos.removeQueueTrack({ uri, position })) });
    } catch (err) {
      console.error("[queue/remove]", err.message);
      res.status(502).json({ error: err.message || "Could not remove the song." });
    }
  }));

  app.post("/api/queue/reorder", destructiveLimit, requireHostControls, asyncHandler(async (req, res) => {
    const { uri, fromPosition, beforeUri, beforePosition } = req.body ?? {};
    if (!uri) return res.status(400).json({ error: "Missing track uri." });
    try {
      res.json({
        ok: true,
        ...(await sonos.reorderQueueTrack({ uri, fromPosition, beforeUri, beforePosition })),
      });
    } catch (err) {
      console.error("[queue/reorder]", err.message);
      res.status(502).json({ error: err.message || "Could not move the song." });
    }
  }));

  app.post("/api/queue/clear", destructiveLimit, requireHostControls, asyncHandler(async (_req, res) => {
    try {
      // Bump preempt before awaiting clear work so an in-flight announce block
      // aborts between pad inserts instead of finishing the whole ramp/TTS/restore.
      preemptQueueWork();
      const result = await sonos.clearQueueWithoutAutoRefill();
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[clear]", err.message);
      res.status(502).json({ error: err.message || "Could not clear the Sonos queue." });
    }
  }));
}
