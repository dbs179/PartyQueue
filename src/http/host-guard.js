// DNS-rebinding guard for the API. The CSRF Origin check in server.js compares
// Origin to Host, but a rebound attacker domain matches itself — so the Host
// header must also be one we consider "ours". LAN-legitimate Hosts are IP
// literals, single-label names (tower, partyqueue), and mDNS *.local names;
// none of those can be a public attacker-controlled domain. Dotted public
// names must be explicitly allowed via PUBLIC_BASE_URL or
// PARTYQUEUE_ALLOWED_HOSTS (comma-separated).

import net from "node:net";

function hostnameOf(hostHeader) {
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function configuredHostnames() {
  const names = [];
  const base = String(process.env.PUBLIC_BASE_URL || "").trim();
  if (base) {
    try {
      names.push(new URL(base).hostname.toLowerCase());
    } catch {
      /* malformed PUBLIC_BASE_URL never blocks requests */
    }
  }
  for (const entry of String(process.env.PARTYQUEUE_ALLOWED_HOSTS || "").split(",")) {
    const name = entry.trim().toLowerCase();
    if (name) names.push(name);
  }
  return names;
}

/** @param {string} hostHeader raw Host header (may include :port) */
export function isAllowedHostHeader(hostHeader) {
  const raw = String(hostHeader || "").trim();
  if (!raw) return true; // non-browser clients; browsers always send Host
  const hostname = hostnameOf(raw);
  if (!hostname) return false;
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) return true;
  if (!hostname.includes(".")) return true; // single-label LAN name
  if (hostname.endsWith(".local")) return true; // mDNS
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  return configuredHostnames().includes(hostname);
}

/** Express middleware for API routes. */
export function hostGuard(req, res, next) {
  if (isAllowedHostHeader(req.headers.host)) return next();
  return res.status(403).json({
    error:
      "Host not allowed. Add this hostname to PARTYQUEUE_ALLOWED_HOSTS or set PUBLIC_BASE_URL.",
  });
}
