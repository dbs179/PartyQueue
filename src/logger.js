// Small structured logger for PartyQueue. Default output stays human-readable
// for Unraid/console; set LOG_FORMAT=json for one JSON object per line.

function envWantsJson() {
  const raw = String(process.env.LOG_FORMAT || "").trim().toLowerCase();
  return raw === "json" || raw === "structured";
}

function serializeError(err) {
  if (!err) return undefined;
  if (typeof err === "string") return { message: err };
  return {
    message: err.message || String(err),
    name: err.name || undefined,
    code: err.code || undefined,
  };
}

function normalizeMeta(meta) {
  if (meta == null) return undefined;
  if (typeof meta !== "object" || Array.isArray(meta)) {
    return { value: meta };
  }
  const out = { ...meta };
  if (out.err != null) {
    out.err = serializeError(out.err);
  }
  return out;
}

function writeHuman(sink, level, scope, message, meta) {
  const prefix = scope ? `[${scope}]` : "[app]";
  const method =
    level === "error"
      ? "error"
      : level === "warn"
        ? "warn"
        : level === "debug"
          ? "debug"
          : "log";
  const fn = typeof sink[method] === "function" ? sink[method].bind(sink) : sink.log?.bind(sink);
  if (!fn) return;
  if (meta && Object.keys(meta).length) {
    fn(prefix, message, meta);
  } else {
    fn(prefix, message);
  }
}

function writeJson(sink, level, scope, message, meta, now) {
  const line = JSON.stringify({
    ts: new Date(now()).toISOString(),
    level,
    scope: scope || "app",
    msg: message,
    ...(meta || {}),
  });
  const method =
    level === "error" ? "error" : level === "warn" ? "warn" : "log";
  const fn = typeof sink[method] === "function" ? sink[method].bind(sink) : console.log;
  fn(line);
}

/**
 * @param {string} [scope]
 * @param {{ sink?: Console, json?: boolean, now?: () => number }} [options]
 */
export function createLogger(scope = "app", options = {}) {
  const sink = options.sink || console;
  const json = options.json ?? envWantsJson();
  const now = options.now || Date.now;

  function log(level, message, meta) {
    const normalized = normalizeMeta(meta);
    if (json) writeJson(sink, level, scope, String(message), normalized, now);
    else writeHuman(sink, level, scope, String(message), normalized);
  }

  return {
    scope,
    info(message, meta) {
      log("info", message, meta);
    },
    warn(message, meta) {
      log("warn", message, meta);
    },
    error(message, meta) {
      log("error", message, meta);
    },
    debug(message, meta) {
      log("debug", message, meta);
    },
    child(subScope) {
      const next = scope ? `${scope}/${subScope}` : String(subScope);
      return createLogger(next, { sink, json, now });
    },
  };
}

/** Default app logger (human or JSON based on LOG_FORMAT). */
export const logger = createLogger("partyqueue");
