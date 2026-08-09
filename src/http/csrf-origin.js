// CSRF / DNS-rebinding helper for state-changing requests.
//
// Always reject Origin that doesn't match Host when Origin is present.
// When PUBLIC_BASE_URL is configured (typical Docker/Unraid deploy), also
// require an Origin header on mutating API/auth requests so bare curl/scripts
// can't drive the party from outside the web app. Browser same-origin calls
// always send Origin.

/**
 * @param {{ publicBaseUrl?: string|null }} [opts]
 */
export function shouldRequireMutatingOrigin(opts = {}) {
  const raw =
    opts.publicBaseUrl !== undefined
      ? opts.publicBaseUrl
      : process.env.PUBLIC_BASE_URL;
  return !!String(raw || "").trim();
}

/**
 * @param {string|undefined|null} originHeader
 * @param {string|undefined|null} hostHeader
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export function evaluateMutatingOrigin(originHeader, hostHeader, opts = {}) {
  const requireOrigin = shouldRequireMutatingOrigin(opts);
  const origin = String(originHeader || "").trim();
  if (!origin) {
    if (requireOrigin) {
      return {
        ok: false,
        status: 403,
        error: "Origin required for this request.",
      };
    }
    return { ok: true };
  }

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return { ok: false, status: 403, error: "Bad origin." };
  }

  const host = String(hostHeader || "").trim();
  if (!host || originHost !== host) {
    return { ok: false, status: 403, error: "Cross-origin request blocked." };
  }
  return { ok: true };
}

/** Express middleware. */
export function csrfOriginGuard(req, res, next) {
  const method = String(req.method || "").toUpperCase();
  if (
    method !== "POST" &&
    method !== "DELETE" &&
    method !== "PUT" &&
    method !== "PATCH"
  ) {
    return next();
  }

  const result = evaluateMutatingOrigin(req.get("origin"), req.headers.host);
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }
  return next();
}
