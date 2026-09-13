// Hold the room on a parked stall pad until the announce is ready.
//
// When a song will finish before the DJ clip has been generated, PartyQueue
// parks a short silence pad in front of the guest's request to buy time. Left
// alone that pad simply plays out in a few seconds and the request starts
// without its announce, so something has to sit on it.
//
// This is deliberately the smallest possible piece of transport control: it
// Pauses once when the pad reaches the playhead, and Plays once when released.
// The pad carries no volume meaning — the baked announce brings its own silence
// to ramp under — so there is nothing else to coordinate.

/**
 * @param {{
 *   padUrl: string,
 *   io: {
 *     read: () => Promise<{ uri: string, state: string }>,
 *     pause: () => Promise<void>,
 *     resume: () => Promise<void>,
 *     sleep: (ms: number) => Promise<void>,
 *     now?: () => number,
 *   },
 *   pollMs?: number,
 *   maxHoldMs?: number,
 *   logger?: object,
 * }} opts
 */
export function createStallHold({
  padUrl,
  io,
  pollMs = 200,
  maxHoldMs = 10_000,
  onDeadline = null,
  logger = console,
}) {
  const now = io.now ?? Date.now;
  let held = false;
  let done = false;
  let watching = null;

  const matches = (uri) => {
    const value = String(uri || "");
    const want = String(padUrl || "");
    if (!value || !want) return false;
    if (value === want) return true;
    // The pad URL carries a per-announce token, so compare the whole tail
    // rather than just the file name: two parked shouts share a file name.
    const tail = want.split("/").pop() || "";
    return !!tail && value.includes(tail);
  };

  async function watch() {
    const started = now();
    while (!done && now() - started < maxHoldMs) {
      let tick;
      try {
        tick = await io.read();
      } catch (err) {
        logger.warn?.(`[stall] transport read failed: ${err?.message || err}`);
        await io.sleep(pollMs);
        continue;
      }
      const state = String(tick?.state || "");
      if (
        !held &&
        matches(tick?.uri) &&
        (state === "PLAYING" || state === "TRANSITIONING")
      ) {
        try {
          await io.pause();
          held = true;
          logger.info?.("[stall] holding on the parked pad until the DJ is ready");
        } catch (err) {
          logger.warn?.(`[stall] could not hold the pad: ${err?.message || err}`);
        }
      }
      if (done) break;
      await io.sleep(pollMs);
    }
    if (!done && held) {
      // Self-heal: never leave the party paused because an announce died.
      logger.warn?.("[stall] hold exceeded its deadline — skipping to the request");
      if (typeof onDeadline === "function") {
        done = true;
        try {
          await onDeadline();
        } catch (err) {
          logger.warn?.(
            `[stall] deadline handler failed; resuming: ${err?.message || err}`
          );
          await resume("deadline");
        }
      } else {
        await resume("deadline");
      }
    }
  }

  async function resume(reason) {
    if (!held) return false;
    held = false;
    try {
      await io.resume();
      logger.info?.(`[stall] released the pad (${reason})`);
      return true;
    } catch (err) {
      logger.error?.(`[stall] could not resume after hold: ${err?.message || err}`);
      return false;
    }
  }

  return {
    start() {
      if (watching) return watching;
      watching = watch().catch((err) =>
        logger.error?.(`[stall] watcher crashed: ${err?.message || err}`)
      );
      return watching;
    },
    /** True once the transport is actually paused on the pad. */
    get held() {
      return held;
    },
    /** Let the room roll on into the announce. */
    async release(reason = "announce ready") {
      done = true;
      return resume(reason);
    },
    async stop() {
      done = true;
    },
  };
}
