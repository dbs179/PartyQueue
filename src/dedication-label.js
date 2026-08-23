/**
 * Open-text dedications: guests may type a name ("Mia") or a full line
 * ("To Mia from Davey"). Only add For/From when the note does not already
 * carry that meaning.
 */

const FOR_TO_LEAD =
  /^(?:for|to|going out to|goes out to|this one(?:'s| is)? for|this one (?:goes|is going) out to|dedicated to)\b/i;
const HAS_FROM = /\bfrom\b/i;

function collapseSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function mentionsRequester(text, requester) {
  const by = collapseSpaces(requester);
  if (!by) return false;
  const escaped = by.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

/** True when the note already reads as a dedication, not a bare name. */
export function dedicationIsPhrased(dedication) {
  const note = collapseSpaces(dedication);
  if (!note) return false;
  return FOR_TO_LEAD.test(note) || HAS_FROM.test(note);
}

/**
 * Badge / toast / wall label. Bare "Mia" + Dave → "For Mia from Dave".
 * "To Mia from Davey" stays as written.
 */
export function formatDedicationLabel(dedication, requester) {
  const note = collapseSpaces(dedication);
  if (!note) return "";
  const by = collapseSpaces(requester);
  if (HAS_FROM.test(note)) return note;
  if (FOR_TO_LEAD.test(note)) {
    if (by && !mentionsRequester(note, by)) return `${note} from ${by}`;
    return note;
  }
  const core = `For ${note}`;
  if (by && !mentionsRequester(note, by)) return `${core} from ${by}`;
  return core;
}

/** Template / spoken beat. Phrased notes are used as the whole line. */
export function dedicationSpeakLine(dedication, _requester) {
  const note = collapseSpaces(dedication);
  if (!note) return "";
  if (dedicationIsPhrased(note)) {
    return /[.!?]$/.test(note) ? note : `${note}.`;
  }
  return `This one goes out to ${note}.`;
}

/** DJ shout prompt rule. */
export function dedicationShoutInstruction(dedication, requester) {
  const note = collapseSpaces(dedication);
  if (!note) return `- No dedication — do not invent a dedicatee.`;
  if (dedicationIsPhrased(note)) {
    return `- REQUIRED: include this dedication as written — "${note}". Do not add extra For, To, From, or "goes out to" on top of it.`;
  }
  const by = collapseSpaces(requester);
  const fromHint = by ? ` The requester is ${by} — you may say from ${by} once, not twice.` : "";
  return `- REQUIRED: say this request goes out to ${note} (dedication). Keep it natural — e.g. "this one goes out to ${note}". Do not invent extra For/From lines.${fromHint}`;
}
