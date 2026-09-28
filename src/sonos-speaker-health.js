// Per-speaker Sonos responsiveness. Observability only: this module never
// removes a speaker, skips one, or restarts the manager.
//
// Transitions (communication failures only — timeouts, refused/reset
// connections, unreachable hosts). A Sonos fault that means the speaker
// answered (701, 711, 800, bad request) is not a health failure.
//
//   UNKNOWN + success                         -> HEALTHY
//   UNKNOWN + 1 communication failure         -> DEGRADED
//   HEALTHY + 1 communication failure         -> DEGRADED
//   DEGRADED + success                        -> HEALTHY
//   DEGRADED + 3rd consecutive failure        -> UNRESPONSIVE
//   UNRESPONSIVE + 2 consecutive successes    -> HEALTHY
//   UNRESPONSIVE + further failures           -> stays UNRESPONSIVE (no log)
//
// There is no OFFLINE state. A dead Wi-Fi radio and a wedged Sonos service
// look the same from here: the SOAP call does not come back.

export const SPEAKER_HEALTH_STATE = {
  UNKNOWN: "UNKNOWN",
  HEALTHY: "HEALTHY",
  DEGRADED: "DEGRADED",
  UNRESPONSIVE: "UNRESPONSIVE",
};

/** Consecutive communication failures before UNRESPONSIVE. */
export const UNRESPONSIVE_AFTER_FAILURES = 3;
/** Confirmed responses required to leave UNRESPONSIVE. */
export const RECOVERY_SUCCESSES = 2;

/** One read-only probe per speaker, no more often than this. */
export const SPEAKER_HEALTH_PROBE_MS = 60_000;
/**
 * Skip the probe when ordinary traffic already updated this speaker this
 * recently (a success or a communication failure). A coordinator the
 * now-playing poll is already timing out must not also be probed.
 */
export const SPEAKER_HEALTH_RECENT_SIGNAL_MS = 45_000;
export const SPEAKER_HEALTH_PROBE_TIMEOUT_MS = 2_000;

/** @type {Map<string, SpeakerHealthRecord>} */
const records = new Map();
/** @type {ReturnType<typeof setInterval> | null} */
let probeTimer = null;
/** @type {Promise<unknown> | null} */
let probeInFlight = null;
/** @type {(line: string) => void} */
let logLine = (line) => console.warn(line);
/** @type {null | (() => unknown[] | Promise<unknown[]>)} */
let listDevices = null;
/** @type {null | ((device: object) => Promise<void>)} */
let readDevice = null;
/** @type {null | ((err: unknown) => boolean)} */
let isCommunicationFailure = null;

/**
 * @typedef {{
 *   key: string,
 *   name: string,
 *   host: string,
 *   uuid: string,
 *   state: string,
 *   lastSuccessAt: number,
 *   lastFailureAt: number,
 *   consecutiveFailures: number,
 *   consecutiveSuccesses: number,
 *   lastFailureReason: string,
 *   lastLatencyMs: number | null,
 *   stateChangedAt: number,
 * }} SpeakerHealthRecord
 */

/**
 * @param {(line: string) => void} fn
 */
export function setSpeakerHealthLoggerForTests(fn) {
  logLine = typeof fn === "function" ? fn : (line) => console.warn(line);
}

export function resetSpeakerHealthForTests() {
  records.clear();
  stopSonosSpeakerHealthMonitor();
  probeInFlight = null;
  logLine = (line) => console.warn(line);
  listDevices = null;
  readDevice = null;
  isCommunicationFailure = null;
}

function identityOf(device) {
  const host = device?.Host ? String(device.Host) : "";
  const uuid = device?.Uuid ? String(device.Uuid) : "";
  const name = device?.Name ? String(device.Name) : "";
  return {
    key: host || uuid || name,
    name: name || host || "Speaker",
    host,
    uuid,
  };
}

/**
 * @param {ReturnType<typeof identityOf>} id
 * @param {number} now
 * @returns {SpeakerHealthRecord}
 */
function blankRecord(id, now) {
  return {
    key: id.key,
    name: id.name,
    host: id.host,
    uuid: id.uuid,
    state: SPEAKER_HEALTH_STATE.UNKNOWN,
    lastSuccessAt: 0,
    lastFailureAt: 0,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastFailureReason: "",
    lastLatencyMs: null,
    stateChangedAt: now,
  };
}

function touchIdentity(record, id) {
  if (id.name) record.name = id.name;
  if (id.host) record.host = id.host;
  if (id.uuid) record.uuid = id.uuid;
}

function logTransition(record, from, reason) {
  const why = reason ? `: ${reason}` : "";
  logLine(`[Sonos Health] ${record.name} ${from} -> ${record.state}${why}`);
}

/**
 * @param {SpeakerHealthRecord} record
 * @param {string} to
 * @param {number} now
 * @param {string} [reason]
 */
function move(record, to, now, reason) {
  if (record.state === to) return;
  const from = record.state;
  record.state = to;
  record.stateChangedAt = now;
  logTransition(record, from, reason);
}

/**
 * Short label stored on the record and shown in the Booth.
 * @param {unknown} err
 */
export function communicationFailureReason(err) {
  const code = String(err?.code || "");
  const msg = String(err?.message || err || "");
  const blob = `${code} ${msg}`;
  if (code === "ETIMEDOUT" || /timed out/i.test(blob)) return "timeout";
  if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(blob)) return "connection refused";
  if (code === "ECONNRESET" || /ECONNRESET/.test(blob)) return "connection reset";
  if (/EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|unreachable/i.test(blob)) return "unreachable";
  return "communication failure";
}

/**
 * @param {object|null|undefined} device
 * @param {{ latencyMs?: number, now?: number }} [opts]
 */
export function noteSpeakerHealthSuccess(device, opts = {}) {
  const id = identityOf(device);
  if (!id.key) return null;
  const now = opts.now || Date.now();
  const record = records.get(id.key) || blankRecord(id, now);
  touchIdentity(record, id);
  record.lastSuccessAt = now;
  record.consecutiveFailures = 0;
  record.consecutiveSuccesses += 1;
  if (Number.isFinite(opts.latencyMs) && opts.latencyMs >= 0) {
    record.lastLatencyMs = Math.round(opts.latencyMs);
  }
  if (record.state === SPEAKER_HEALTH_STATE.UNRESPONSIVE) {
    if (record.consecutiveSuccesses >= RECOVERY_SUCCESSES) {
      move(record, SPEAKER_HEALTH_STATE.HEALTHY, now);
    }
  } else if (record.state !== SPEAKER_HEALTH_STATE.HEALTHY) {
    move(record, SPEAKER_HEALTH_STATE.HEALTHY, now);
  }
  records.set(id.key, record);
  return publicSpeaker(record);
}

/**
 * Record a communication failure. Callers must not pass ordinary Sonos
 * refusals (the speaker answered). Further failures while UNRESPONSIVE update
 * the counters and do not log again.
 * @param {object|null|undefined} device
 * @param {unknown} err
 * @param {{ latencyMs?: number, now?: number }} [opts]
 */
export function noteSpeakerHealthFailure(device, err, opts = {}) {
  const id = identityOf(device);
  if (!id.key) return null;
  const now = opts.now || Date.now();
  const record = records.get(id.key) || blankRecord(id, now);
  touchIdentity(record, id);
  record.lastFailureAt = now;
  record.lastFailureReason = communicationFailureReason(err);
  record.consecutiveSuccesses = 0;
  record.consecutiveFailures += 1;
  if (Number.isFinite(opts.latencyMs) && opts.latencyMs >= 0) {
    record.lastLatencyMs = Math.round(opts.latencyMs);
  }
  if (record.state !== SPEAKER_HEALTH_STATE.UNRESPONSIVE) {
    const next =
      record.consecutiveFailures >= UNRESPONSIVE_AFTER_FAILURES
        ? SPEAKER_HEALTH_STATE.UNRESPONSIVE
        : SPEAKER_HEALTH_STATE.DEGRADED;
    const reason =
      next === SPEAKER_HEALTH_STATE.UNRESPONSIVE
        ? `${record.consecutiveFailures} consecutive failures`
        : record.lastFailureReason;
    move(record, next, now, reason);
  }
  records.set(id.key, record);
  return publicSpeaker(record);
}

/**
 * Remember speakers we have seen but not yet measured. Does not log.
 * @param {object[]|null|undefined} devices
 */
export function observeKnownSpeakers(devices) {
  const now = Date.now();
  for (const device of devices || []) {
    const id = identityOf(device);
    if (!id.key || records.has(id.key)) continue;
    records.set(id.key, blankRecord(id, now));
  }
}

function publicSpeaker(record) {
  return {
    name: record.name,
    host: record.host,
    uuid: record.uuid,
    state: record.state,
    consecutiveFailures: record.consecutiveFailures,
    consecutiveSuccesses: record.consecutiveSuccesses,
    lastSuccessAt: record.lastSuccessAt,
    lastFailureAt: record.lastFailureAt,
    lastFailureReason: record.lastFailureReason,
    lastLatencyMs: record.lastLatencyMs,
    stateChangedAt: record.stateChangedAt,
  };
}

export function listSpeakerHealth() {
  return [...records.values()]
    .map(publicSpeaker)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Booth / diagnostics line. DEGRADED and UNRESPONSIVE include the failure count.
 * @param {ReturnType<typeof publicSpeaker>} speaker
 * @param {{ formatTime?: (ms: number) => string }} [opts]
 */
export function formatSpeakerHealthLine(speaker, opts = {}) {
  const name = speaker?.name || speaker?.host || "Speaker";
  const head = `${name} — ${speaker?.state || SPEAKER_HEALTH_STATE.UNKNOWN}`;
  if (
    speaker?.state !== SPEAKER_HEALTH_STATE.DEGRADED &&
    speaker?.state !== SPEAKER_HEALTH_STATE.UNRESPONSIVE
  ) {
    return head;
  }
  const n = Number(speaker.consecutiveFailures) || 0;
  const reason = speaker.lastFailureReason || "communication failure";
  const detail =
    reason === "timeout"
      ? `${n} consecutive timeout${n === 1 ? "" : "s"}`
      : `${n} consecutive failure${n === 1 ? "" : "s"} (${reason})`;
  const formatTime =
    opts.formatTime ||
    ((ms) =>
      new Date(ms).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }));
  const when = speaker.lastSuccessAt ? formatTime(speaker.lastSuccessAt) : "none";
  return `${head}\n${detail}\nLast response: ${when}`;
}

export function formatSpeakerHealthList(speakers, opts = {}) {
  const rows = Array.isArray(speakers) ? speakers : [];
  if (!rows.length) return "No Sonos speakers seen yet.";
  return rows.map((speaker) => formatSpeakerHealthLine(speaker, opts)).join("\n\n");
}

function shouldProbe(record, now) {
  const last = Math.max(record?.lastSuccessAt || 0, record?.lastFailureAt || 0);
  if (!last) return true;
  return now - last >= SPEAKER_HEALTH_RECENT_SIGNAL_MS;
}

/**
 * One pass over known speakers. A pass already running returns immediately.
 * Speakers that answered ordinary traffic recently are left alone.
 * @param {{
 *   listDevices: () => unknown[] | Promise<unknown[]>,
 *   readDevice: (device: object) => Promise<void>,
 *   isCommunicationFailure?: (err: unknown) => boolean,
 *   now?: () => number,
 * }} deps
 */
export async function runSonosSpeakerHealthProbe(deps) {
  if (probeInFlight) return { skipped: "overlap" };
  const run = probeOnce(deps);
  probeInFlight = run;
  try {
    return await run;
  } finally {
    if (probeInFlight === run) probeInFlight = null;
  }
}

async function probeOnce(deps) {
  const now = typeof deps.now === "function" ? deps.now() : Date.now();
  const devices = await deps.listDevices();
  observeKnownSpeakers(Array.isArray(devices) ? devices : []);
  let probed = 0;
  let skipped = 0;
  for (const device of Array.isArray(devices) ? devices : []) {
    const id = identityOf(device);
    if (!id.key) continue;
    if (typeof device?.AVTransportService?.GetTransportInfo !== "function") continue;
    const record = records.get(id.key);
    if (record && !shouldProbe(record, now)) {
      skipped += 1;
      continue;
    }
    const started = Date.now();
    try {
      await deps.readDevice(device);
      noteSpeakerHealthSuccess(device, { latencyMs: Date.now() - started });
      probed += 1;
    } catch (err) {
      const comm = deps.isCommunicationFailure
        ? deps.isCommunicationFailure(err)
        : true;
      if (comm) {
        noteSpeakerHealthFailure(device, err, { latencyMs: Date.now() - started });
      }
      probed += 1;
    }
  }
  return { skipped: false, probed, recent: skipped };
}

/**
 * Start the low-frequency probe. Idempotent: a second call does not add a timer.
 * @param {{
 *   listDevices: () => unknown[] | Promise<unknown[]>,
 *   readDevice: (device: object) => Promise<void>,
 *   isCommunicationFailure?: (err: unknown) => boolean,
 *   setInterval?: typeof setInterval,
 *   clearInterval?: typeof clearInterval,
 *   intervalMs?: number,
 * }} deps
 * @returns {boolean} true when this call armed the timer
 */
export function startSonosSpeakerHealthMonitor(deps) {
  if (probeTimer) return false;
  listDevices = deps.listDevices;
  readDevice = deps.readDevice;
  isCommunicationFailure = deps.isCommunicationFailure || null;
  const setInt = deps.setInterval || setInterval;
  const ms = deps.intervalMs || SPEAKER_HEALTH_PROBE_MS;
  probeTimer = setInt(() => {
    if (!listDevices || !readDevice) return;
    void runSonosSpeakerHealthProbe({
      listDevices,
      readDevice,
      isCommunicationFailure: isCommunicationFailure || undefined,
    }).catch(() => {
      /* a probe must not take the process down */
    });
  }, ms);
  probeTimer.unref?.();
  return true;
}

export function stopSonosSpeakerHealthMonitor(clearInt = clearInterval) {
  if (probeTimer) {
    try {
      clearInt(probeTimer);
    } catch {
      /* a test double is not a real timer */
    }
  }
  probeTimer = null;
  listDevices = null;
  readDevice = null;
  isCommunicationFailure = null;
}

export function speakerHealthMonitorArmed() {
  return !!probeTimer;
}
