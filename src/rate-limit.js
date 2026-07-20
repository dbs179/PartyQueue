// Soft per-IP rate limit for destructive / noisy APIs (clear, random, transport).
// Blunts LAN pranks without requiring auth.

/**
 * @param {{
 *   windowMs?: number,
 *   max?: number,
 *   message?: string,
 *   now?: () => number
 * }} [opts]
 */
export function softRateLimit(opts = {}) {
  const windowMs = opts.windowMs ?? 3000;
  const max = opts.max ?? 1;
  const now = opts.now ?? Date.now;
  const message =
    opts.message || "Slow down — try again in a moment.";
  /** @type {Map<string, { count: number, reset: number }>} */
  const hits = new Map();

  // Opportunistic cleanup so the map can't grow forever on a busy LAN.
  let lastSweep = now();

  return function rateLimitMiddleware(req, res, next) {
    const currentTime = now();
    if (currentTime - lastSweep > 60_000) {
      lastSweep = currentTime;
      for (const [k, v] of hits) {
        if (currentTime > v.reset) hits.delete(k);
      }
    }

    const key = req.ip || req.socket?.remoteAddress || "unknown";
    let bucket = hits.get(key);
    if (!bucket || currentTime >= bucket.reset) {
      bucket = { count: 0, reset: currentTime + windowMs };
    }
    bucket.count += 1;
    hits.set(key, bucket);

    if (bucket.count > max) {
      const retryMs = Math.max(0, bucket.reset - currentTime);
      res.set("Retry-After", String(Math.ceil(retryMs / 1000)));
      return res.status(429).json({ error: message, retryMs });
    }
    return next();
  };
}
