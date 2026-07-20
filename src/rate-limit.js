// Soft per-IP rate limit for destructive / noisy APIs (clear, random, transport).
// Blunts LAN pranks without requiring auth.

/**
 * @param {{ windowMs?: number, max?: number, message?: string }} [opts]
 */
export function softRateLimit(opts = {}) {
  const windowMs = opts.windowMs ?? 3000;
  const max = opts.max ?? 1;
  const message =
    opts.message || "Slow down — try again in a moment.";
  /** @type {Map<string, { count: number, reset: number }>} */
  const hits = new Map();

  // Opportunistic cleanup so the map can't grow forever on a busy LAN.
  let lastSweep = Date.now();

  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    if (now - lastSweep > 60_000) {
      lastSweep = now;
      for (const [k, v] of hits) {
        if (now > v.reset) hits.delete(k);
      }
    }

    const key = req.ip || req.socket?.remoteAddress || "unknown";
    let bucket = hits.get(key);
    if (!bucket || now > bucket.reset) {
      bucket = { count: 0, reset: now + windowMs };
    }
    bucket.count += 1;
    hits.set(key, bucket);

    if (bucket.count > max) {
      const retryMs = Math.max(0, bucket.reset - now);
      res.set("Retry-After", String(Math.ceil(retryMs / 1000)));
      return res.status(429).json({ error: message, retryMs });
    }
    return next();
  };
}
