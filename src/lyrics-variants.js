// Artist/title spellings providers often index differently from Sonos metadata.

/**
 * Return unique artist strings to try when a punctuated band name misses.
 * Example: "Sixx:A.M." → ["Sixx:A.M.", "Sixx A.M.", "Sixx AM", "Sixx A M", "SixxAM"]
 */
export function artistLookupVariants(artist) {
  const original = String(artist || "").trim();
  if (!original) return [];

  const out = [];
  const push = (value) => {
    const next = String(value || "").replace(/\s+/g, " ").trim();
    if (next && !out.includes(next)) out.push(next);
  };

  push(original);
  // Prefer spaced punctuation cleanup ("Sixx AM") before compacted forms.
  push(original.replace(/[:/\\|]+/g, " "));
  push(original.replace(/[:/\\|]+/g, " ").replace(/\./g, ""));
  push(original.replace(/[^\p{L}\p{N}]+/gu, " "));
  push(original.replace(/[.:]+/g, ""));
  push(original.replace(/[^\p{L}\p{N}]+/gu, ""));
  return out;
}
