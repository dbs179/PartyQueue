// One-shot next-set DJ packs for Node-RED / Home Assistant flows.
// Arm a pack before clear+random; the next set announce consumes it once.

const ARM_TTL_MS = 15 * 60 * 1000;

/** @typedef {{ id: string, label: string, alwaysInstructions: string, neverInstructions: string, intros: string[], blurbs: string[], outros: string[] }} DjSetPack */

/** @type {DjSetPack[]} */
const DJ_SET_PACKS = [
  {
    id: "maria-cooking",
    label: "Maria is cooking dinner",
    alwaysInstructions:
      "Maria is cooking dinner. Open by naming Maria. Warm kitchen energy. Celebrate her as a great wife who runs the house like a boss. Keep it loving, light, and food-friendly.",
    neverInstructions:
      "Do not invent the exact dish. Do not skip Maria's name on the open. No food-safety lectures. Do not overshadow the music. Keep it PG-13 and skip heavy sentiment.",
    intros: [
      "Maria's cooking dinner — she keeps the stove warm and the food hot.",
      "Maria's in the kitchen cooking dinner, and the house already smells like a win.",
      "Maria's cooking dinner tonight, running that kitchen like a boss.",
      "Maria's cooking dinner, and the soundtrack better keep up.",
      "Maria's cooking dinner, keeping the stove warm and the whole house happy.",
      "Maria's cooking dinner right now, great wife energy with a hot stove.",
      "Maria's cooking dinner and holding it down — kitchen first, music next.",
      "Maria's cooking dinner, keeping the food hot and the night on track.",
    ],
    blurbs: [
      "Say Maria is cooking dinner and keeping the stove warm and the food hot.",
      "Call out that Maria's cooking dinner and running the house like a boss.",
      "Celebrate Maria cooking dinner — great wife energy, light and warm.",
      "One clear line that Maria's cooking dinner, then back to the music.",
      "Tie the set to Maria cooking dinner and keeping everyone fed.",
      "Mention Maria cooking dinner with hot-stove, happy-house energy.",
      "Keep it domestic and upbeat: Maria's cooking dinner tonight.",
      "Hit that Maria-is-cooking-dinner beat once, then hand it to the songs.",
    ],
    outros: [
      "Maria's got dinner covered. Let the music take it from here.",
      "Keep it warm — Maria's cooking dinner, and the queue's rolling.",
      "Maria's on the stove. You've got the speakers.",
      "Dinner's in Maria's hands. Play on.",
      "Maria's cooking dinner, so enjoy the soundtrack.",
      "Back to the music — Maria's keeping dinner hot.",
      "Let it simmer with Maria in the kitchen. Next track.",
      "Maria's cooking dinner. From here, the speakers lead.",
    ],
  },
];

/** @type {{ packId: string, armedAt: number, expiresAt: number } | null} */
let armed = null;

function packById(id) {
  const key = String(id || "")
    .trim()
    .toLowerCase();
  if (!key) return null;
  return DJ_SET_PACKS.find((pack) => pack.id === key) || null;
}

function expireIfStale(now = Date.now()) {
  if (!armed) return;
  if (now >= armed.expiresAt) {
    armed = null;
  }
}

export function listDjSetPacks() {
  return DJ_SET_PACKS.map((pack) => ({
    id: pack.id,
    label: pack.label,
  }));
}

export function getDjSetPack(id) {
  const pack = packById(id);
  if (!pack) return null;
  return {
    id: pack.id,
    label: pack.label,
    alwaysInstructions: pack.alwaysInstructions,
    neverInstructions: pack.neverInstructions,
    intros: [...pack.intros],
    blurbs: [...pack.blurbs],
    outros: [...pack.outros],
  };
}

/**
 * @param {string} id
 * @param {{ now?: number, ttlMs?: number }} [opts]
 */
export function armDjNextSet(id, opts = {}) {
  const pack = packById(id);
  if (!pack) {
    const known = listDjSetPacks()
      .map((row) => row.id)
      .join(", ");
    const err = new Error(
      known
        ? `Unknown DJ set pack "${id}". Known packs: ${known}.`
        : `Unknown DJ set pack "${id}".`
    );
    err.code = "UNKNOWN_DJ_SET_PACK";
    throw err;
  }
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const ttlMs =
    Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
      ? Math.floor(opts.ttlMs)
      : ARM_TTL_MS;
  armed = {
    packId: pack.id,
    armedAt: now,
    expiresAt: now + ttlMs,
  };
  return getDjNextSetState({ now });
}

export function clearDjNextSet() {
  armed = null;
  return getDjNextSetState();
}

/**
 * Peek the armed pack without consuming. Expires stale arms.
 * @param {{ now?: number }} [opts]
 * @returns {DjSetPack | null}
 */
export function peekDjNextSet(opts = {}) {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  expireIfStale(now);
  if (!armed) return null;
  return getDjSetPack(armed.packId);
}

/**
 * Consume the armed pack (after a set script is written).
 * @param {{ now?: number }} [opts]
 */
export function consumeDjNextSet(opts = {}) {
  const pack = peekDjNextSet(opts);
  armed = null;
  return pack;
}

/**
 * @param {{ now?: number }} [opts]
 */
export function getDjNextSetState(opts = {}) {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  expireIfStale(now);
  const packs = listDjSetPacks();
  if (!armed) {
    return {
      armed: false,
      pack: null,
      label: null,
      armedAt: null,
      expiresAt: null,
      packs,
    };
  }
  const pack = packById(armed.packId);
  return {
    armed: true,
    pack: armed.packId,
    label: pack?.label || armed.packId,
    armedAt: armed.armedAt,
    expiresAt: armed.expiresAt,
    packs,
  };
}

/** @param {{ now?: number }} [opts] */
export function pickDjNextSetLines(opts = {}) {
  const pack = peekDjNextSet(opts);
  if (!pack) return null;
  const salt = Math.abs(
    (Number.isFinite(opts.salt) ? Number(opts.salt) : Date.now()) % 997
  );
  const pick = (arr, offset) => {
    if (!Array.isArray(arr) || !arr.length) return "";
    return String(arr[(salt + offset) % arr.length] || "").trim();
  };
  return {
    pack,
    intro: pick(pack.intros, 0),
    blurb: pick(pack.blurbs, 3),
    outro: pick(pack.outros, 7),
  };
}

export function resetDjSetPacksForTests() {
  armed = null;
}
