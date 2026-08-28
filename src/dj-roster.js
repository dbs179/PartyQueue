// Which DJ speaks: Holy Roller, Sister Static, or Mix (solo + optional banter).

import {
  DJ_PERSONA_HOLY_ROLLER,
  DJ_PERSONA_SISTER_STATIC,
  DJ_VOICE_DEFAULTS,
  getDjPersona,
  getDjRosterSettings,
} from "./settings.js";
import { getLastSoloDjSpeaker } from "./dj-night-memory.js";

export {
  DJ_PERSONA_HOLY_ROLLER,
  DJ_PERSONA_SISTER_STATIC,
};

function clampPct(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function rollPct(percent, rng) {
  const p = clampPct(percent, 0);
  if (p <= 0) return false;
  if (p >= 100) return true;
  return rng() * 100 < p;
}

/**
 * @param {{
 *   kind?: "set" | "shout" | "recap" | "banter-punchline",
 *   rng?: () => number,
 *   roster?: { djRosterMode?: string, djMixHolyRollerPercent?: number, djBanterPercent?: number },
 *   lastSolo?: { personaId?: string, streak?: number } | null,
 * }} [opts]
 */
export function resolveDjForAnnounce({
  kind = "set",
  rng = Math.random,
  roster = null,
  lastSolo = null,
} = {}) {
  const settings = roster || getDjRosterSettings();
  const mode = String(settings.djRosterMode || DJ_VOICE_DEFAULTS.djRosterMode);
  const mixHr = clampPct(
    settings.djMixHolyRollerPercent,
    DJ_VOICE_DEFAULTS.djMixHolyRollerPercent
  );
  const banter = clampPct(
    settings.djBanterPercent,
    DJ_VOICE_DEFAULTS.djBanterPercent
  );

  if (kind === "recap" || kind === "banter-punchline") {
    const personaId =
      kind === "banter-punchline"
        ? DJ_PERSONA_SISTER_STATIC
        : DJ_PERSONA_HOLY_ROLLER;
    return {
      type: "solo",
      personaId,
      leadId: personaId,
      punchId: null,
    };
  }

  if (mode === DJ_PERSONA_SISTER_STATIC) {
    return {
      type: "solo",
      personaId: DJ_PERSONA_SISTER_STATIC,
      leadId: DJ_PERSONA_SISTER_STATIC,
      punchId: null,
    };
  }

  if (mode !== "mix") {
    return {
      type: "solo",
      personaId: DJ_PERSONA_HOLY_ROLLER,
      leadId: DJ_PERSONA_HOLY_ROLLER,
      punchId: null,
    };
  }

  if (kind === "set" && rollPct(banter, rng)) {
    return {
      type: "duet",
      personaId: DJ_PERSONA_HOLY_ROLLER,
      leadId: DJ_PERSONA_HOLY_ROLLER,
      punchId: DJ_PERSONA_SISTER_STATIC,
    };
  }

  let personaId = rollPct(mixHr, rng)
    ? DJ_PERSONA_HOLY_ROLLER
    : DJ_PERSONA_SISTER_STATIC;

  const prior = lastSolo || getLastSoloDjSpeaker();
  const streak = Number(prior?.streak) || 0;
  const lastId = prior?.personaId || null;
  if (
    mixHr >= 20 &&
    mixHr <= 80 &&
    lastId &&
    personaId === lastId &&
    streak >= 2
  ) {
    personaId =
      personaId === DJ_PERSONA_HOLY_ROLLER
        ? DJ_PERSONA_SISTER_STATIC
        : DJ_PERSONA_HOLY_ROLLER;
  }

  return {
    type: "solo",
    personaId,
    leadId: personaId,
    punchId: null,
  };
}

/** Resolved profile for an assignment (lead speaker unless punch is requested). */
export function personaFromAssignment(assignment, { punch = false } = {}) {
  if (punch && assignment?.punchId) {
    return getDjPersona(assignment.punchId);
  }
  const id =
    assignment?.leadId ||
    assignment?.personaId ||
    DJ_PERSONA_HOLY_ROLLER;
  return getDjPersona(id);
}
