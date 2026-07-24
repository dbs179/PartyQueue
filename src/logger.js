// Small structured logger for PartyQueue. Default output stays human-readable
// for Unraid/console; set LOG_FORMAT=json for one JSON object per line.

export function logFormatIsJson() {
  const raw = String(process.env.LOG_FORMAT || "").trim().toLowerCase();
  return raw === "json" || raw === "structured";
}

function serializeError(err) {
  if (!err) return undefined;
  if (typeof err === "string") return { message: redactString(err) };
  return {
    message: redactString(err.message || String(err)),
    name: err.name || undefined,
    code: err.code || undefined,
  };
}

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /authorization|cookie|credential|password|pin|secret|session|token|api[_-]?key/i;

export function redactString(value) {
  return String(value)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${REDACTED}`)
    .replace(
      /\b(SPOTIFY_CLIENT_SECRET|SPOTIFY_REFRESH_TOKEN|HA_TOKEN|LASTFM_API_KEY|SETTINGS_PIN|OPENAI_API_KEY|ELEVENLABS_API_KEY)\s*=\s*[^\s,;&]+/gi,
      `$1=${REDACTED}`
    )
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g, REDACTED)
    .replace(/\b[0-9a-f]{32,}\b/gi, REDACTED)
    .replace(/(setup code:\s*)\d{6}\b/gi, `$1${REDACTED}`)
    .replace(
      /([?&](?:access_token|api_key|key|refresh_token|token)=)[^&#\s]+/gi,
      `$1${REDACTED}`
    );
}

export function redactValue(value, key = "", seen = new WeakSet()) {
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (value instanceof Error) return serializeError(value);
  if (typeof value !== "object") return redactString(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, "", seen));
  }
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = redactValue(childValue, childKey, seen);
  }
  return out;
}

function normalizeMeta(meta) {
  if (meta == null) return undefined;
  if (typeof meta !== "object" || Array.isArray(meta)) {
    return { value: redactValue(meta) };
  }
  return redactValue(meta);
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
  const json = options.json ?? logFormatIsJson();
  const now = options.now || Date.now;

  function log(level, message, meta) {
    const normalized = normalizeMeta(meta);
    const safeMessage = redactString(message);
    if (json) writeJson(sink, level, scope, safeMessage, normalized, now);
    else writeHuman(sink, level, scope, safeMessage, normalized);
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
