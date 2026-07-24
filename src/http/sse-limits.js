// Admission guard for SSE endpoints: a LAN client (or bug) opening EventSource
// connections in a loop would otherwise pin one socket + heartbeat timer each,
// without any auth or rate limit in front of it.

export const SSE_MAX_GLOBAL = 150;
export const SSE_MAX_PER_IP = 8;

/**
 * Admit or reject a new SSE subscriber. Client records in `clients` must carry
 * the `ip` this function returns so per-IP counting stays accurate.
 * @param {Map<object, { ip?: string }>} clients current clients for this stream
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {string|null} client IP when admitted, null when a 503 was sent
 */
export function admitSseClient(clients, req, res) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  let mine = 0;
  for (const client of clients.values()) {
    if (client.ip === ip) mine++;
  }
  if (clients.size >= SSE_MAX_GLOBAL || mine >= SSE_MAX_PER_IP) {
    res.set("Retry-After", "10");
    res.status(503).json({ error: "Too many open streams — try again shortly." });
    return null;
  }
  return ip;
}
