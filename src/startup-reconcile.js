// Post-listen repair after crash/restart: re-arm DJ volume handoff, strip
// orphan announce pads that are not a complete handoff block, and prune
// queue-origin metadata that no longer matches the live Sonos queue.

import { spotifyTrackId } from "./sampler.js";
import {
  isAnnounceQueuePad,
  findUpcomingAnnouncePadIndices,
} from "./sonos-queue-policy.js";
import { findUpcomingAnnounceHandoffPlan } from "./skip-announce-policy.js";
import { reconcileOriginsWithQueue } from "./queue-origin.js";

/**
 * Spotify track ids for music rows in a raw Sonos GetQueue result (pads skipped).
 * Order and multiplicity are preserved for searched-origin matching.
 * @param {Array<{ TrackUri?: string, uri?: string, Title?: string, title?: string }>} items
 * @returns {string[]}
 */
export function musicTrackIdsFromQueueItems(items) {
  const ids = [];
  for (const it of Array.isArray(items) ? items : []) {
    const uri = it?.TrackUri ?? it?.uri;
    const title = it?.Title ?? it?.title ?? "";
    if (isAnnounceQueuePad(uri, title)) continue;
    const id = spotifyTrackId(uri);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Pure: whether upcoming announce pads look like orphans (pads present but no
 * complete ramp→TTS→restore handoff plan to re-arm).
 * @param {Array} items
 * @param {number} currentTrack
 * @param {boolean} playingFromQueue
 */
export function shouldStripOrphanAnnouncePads(
  items,
  currentTrack,
  playingFromQueue
) {
  const plan = findUpcomingAnnounceHandoffPlan(items, currentTrack);
  if (plan) return false;
  const indices = findUpcomingAnnouncePadIndices(items, {
    currentTrack,
    playingFromQueue,
  });
  return indices.length > 0;
}

/**
 * Live Sonos reconcile pass. Safe to call once after listen.
 * @returns {Promise<{
 *   ok: boolean,
 *   rearm?: object,
 *   padsRemoved?: number,
 *   origins?: { kept: number, removed: number, liveTrackCount: number },
 *   error?: string,
 * }>}
 */
export async function runStartupQueueReconcile() {
  try {
    const { getManager, resolveCoordinator } = await import("./sonos-core.js");
    const { rearmDjVolumeHandoffFromQueue } = await import("./dj-voice.js");
    const { removeUpcomingAnnouncePads } = await import(
      "./sonos-queue-mutations.js"
    );

    const m = await getManager();
    const coordinator = await resolveCoordinator(m);
    const [pos, media, queue] = await Promise.all([
      coordinator.AVTransportService.GetPositionInfo().catch(() => ({
        Track: 0,
      })),
      coordinator.AVTransportService.GetMediaInfo({ InstanceID: 0 }).catch(
        () => ({ CurrentURI: "" })
      ),
      coordinator.GetQueue().catch(() => ({ Result: [] })),
    ]);

    const items = Array.isArray(queue.Result) ? queue.Result : [];
    const currentTrack = Number(pos.Track) || 0;
    const playingFromQueue = /^x-rincon-queue:/.test(media.CurrentURI || "");

    const rearm = await rearmDjVolumeHandoffFromQueue({
      queueItems: items,
      currentTrack,
    });

    let padsRemoved = 0;
    if (shouldStripOrphanAnnouncePads(items, currentTrack, playingFromQueue)) {
      const stripped = await removeUpcomingAnnouncePads();
      padsRemoved = Number(stripped?.removed) || 0;
    }

    // Re-read after pad strip so origins match the post-cleanup queue.
    let originItems = items;
    if (padsRemoved > 0) {
      const q2 = await coordinator.GetQueue().catch(() => ({ Result: [] }));
      originItems = Array.isArray(q2.Result) ? q2.Result : [];
    }

    const liveIds = musicTrackIdsFromQueueItems(originItems);
    const origins = reconcileOriginsWithQueue(liveIds);

    return {
      ok: true,
      rearm,
      padsRemoved,
      origins,
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
    };
  }
}
