/**
 * After leave/ungroup topology churn, Sonos often leaves the target paused.
 * Capture "was playing from queue" before the mutation and resume once after.
 */

/**
 * @param {{
 *   isPlaying?: boolean,
 *   playingFromQueue?: boolean,
 * }|null|undefined} ctx
 */
export function wasPlayingFromQueue(ctx) {
  return !!(ctx?.isPlaying && ctx?.playingFromQueue);
}

/**
 * @param {{
 *   wasPlaying: boolean,
 *   handoffActive?: boolean,
 *   after?: {
 *     isPlaying?: boolean,
 *     playingFromQueue?: boolean,
 *   }|null,
 * }} opts
 */
export function shouldResumeAfterTopology({
  wasPlaying,
  handoffActive = false,
  after = null,
} = {}) {
  if (!wasPlaying || handoffActive) return false;
  if (after?.isPlaying) return false;
  if (after && after.playingFromQueue === false) return false;
  return true;
}
