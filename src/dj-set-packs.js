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
      "Maria's cooking dinner, and the kitchen's already winning.",
      "Maria's on dinner duty — stove hot, house happy.",
      "Maria's cooking dinner, running that kitchen like she owns the night.",
      "Maria's in there cooking dinner. Music, keep up.",
      "Maria's cooking dinner, great wife energy from the first pan.",
      "Maria's cooking dinner tonight, and the house knows it.",
      "Maria's cooking dinner — warm stove, warmer room.",
      "Maria's cooking dinner, holding the house down with a hot stove.",
      "Maria's cooking dinner. Kitchen first, speakers second.",
      "Maria's cooking dinner, and it already smells like a good night.",
      "Maria's cooking dinner, keeping everyone fed and the vibe easy.",
      "Maria's cooking dinner right now. Let the soundtrack match the stove.",
      "Maria's cooking dinner, boss of the kitchen, boss of the house.",
      "Maria's cooking dinner — food hot, night on track.",
      "Maria's in the kitchen cooking dinner. That's the headline.",
      "Maria's cooking dinner, and the playlist better behave.",
      "Maria's cooking dinner tonight. Warm house, hot pans.",
      "Maria's cooking dinner, keeping the stove honest.",
      "Maria's cooking dinner, and the whole house is in good hands.",
      "Maria's cooking dinner. Great wife energy, no notes.",
      "Maria's cooking dinner, turning the kitchen into the main stage.",
      "Maria's cooking dinner — she runs the house, we run the queue.",
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
      "Name Maria first and say she's cooking dinner right now.",
      "Make the kitchen the scene: Maria's cooking dinner, stove's hot.",
      "Say Maria's cooking dinner and the house already smells like a win.",
      "Call Maria a great wife once, then that she's cooking dinner.",
      "Keep it light: Maria's cooking dinner and running the kitchen.",
      "One warm line that Maria's cooking dinner for the house.",
      "Mention Maria cooking dinner and holding it down at the stove.",
      "Say the soundtrack should keep up while Maria cooks dinner.",
      "Frame the set around Maria cooking dinner, then the first song.",
      "Hit once that Maria's cooking dinner and the night is fed.",
      "Name Maria, name dinner, then get back to the queue.",
      "Keep it PG and warm: Maria's cooking dinner tonight.",
      "Say Maria's in the kitchen cooking dinner like a boss.",
      "One line that Maria's cooking dinner and the house is happy.",
      "Mention hot stove, Maria cooking dinner, then the music.",
      "Call out Maria cooking dinner without inventing the dish.",
      "Say Maria's cooking dinner and keeping the food hot.",
      "Treat Maria cooking dinner as the booth aside, then the opener.",
      "Keep it loving and short: Maria's cooking dinner right now.",
      "Say Maria's cooking dinner and the kitchen's winning.",
      "One domestic beat — Maria's cooking dinner — then the set.",
      "Name Maria cooking dinner, skip the recipe, hand it to the songs.",
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
      "Maria's got the stove. We've got the next song.",
      "Kitchen's covered. Music, you're up.",
      "Maria's cooking dinner. Let the set do the rest.",
      "Stay warm — Maria's on dinner, the queue's on time.",
      "Maria's holding the kitchen. Play on.",
      "Dinner's handled. Back to the speakers.",
      "Maria's cooking dinner. Enjoy the next one.",
      "The stove's in good hands. Next track.",
      "Maria's got dinner. We keep the night moving.",
      "Kitchen first is done. Music next.",
      "Maria's cooking dinner. Take it away.",
      "Keep the house happy — Maria's on the stove. Play on.",
      "Maria's got dinner covered. Here's the next song.",
      "From the kitchen to the speakers. Next up.",
      "Maria's cooking dinner. The set can take it from here.",
      "Stove's hot, queue's ready. Play on.",
      "Maria's in the kitchen. We roll the next track.",
      "Dinner's with Maria. Music's with us.",
      "Maria's cooking dinner. Let it ride.",
      "House is fed. Back to the songs.",
      "Maria's on dinner duty. Speakers, you're clear.",
      "Maria's cooking dinner. From here, just hit play.",
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
