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
      "Maria is cooking dinner. Warm kitchen energy. Celebrate her as a great wife who runs the house like a boss. Keep it loving, light, and food-friendly.",
    neverInstructions:
      "Do not invent the exact dish. No food-safety lectures. Do not overshadow the music. Keep it PG-13 and skip heavy sentiment.",
    intros: [
      "Kitchen's live and so is the soundtrack.",
      "Dinner's underway — Maria's got the house on lock.",
      "From the kitchen to the speakers, we're rolling.",
      "House boss in the kitchen, music in the room.",
      "Maria's cooking, and the queue knows better than to argue.",
      "Warm stove, warm speakers — here's the next stretch.",
      "The kitchen's running like a boss. Music, keep up.",
      "Dinner mode is on. Maria's handling business.",
    ],
    blurbs: [
      "Give a quick nod that Maria's cooking dinner and holding it down.",
      "Call out that the house is in excellent hands tonight.",
      "Celebrate the wife who runs the kitchen and the night.",
      "Keep the love light — great wife energy without getting syrupy.",
      "Tie the set to dinner in the works and a house running smooth.",
      "One warm line about Maria bossing the kitchen, then back to music.",
      "Make the room feel domestic and upbeat, not like a wedding toast.",
      "Hint that dinner's covered so everyone can enjoy the music.",
    ],
    outros: [
      "Dinner's in good hands. So is the soundtrack.",
      "Kitchen energy stays high — let the songs take it.",
      "Maria's got the stove. You've got the speakers.",
      "House boss approved. Play on.",
      "Keep the vibe warm while dinner comes together.",
      "Back to the music — the kitchen's covered.",
      "Let it simmer. The queue's got the next move.",
      "From here, the speakers lead.",
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
