// Artist/title spellings providers often index differently from Sonos metadata.

/**
 * Artist credits Spotify/Sonos often attach that providers index under the
 * primary name alone. LRClib's search for "Dr. Dre feat. Eminem" returns
 * plain-only rows while "Dr. Dre" has synced lyrics.
 * Example: "Dr. Dre feat. Eminem" → ["Dr. Dre feat. Eminem", "Dr. Dre"]
 */
export function artistCreditVariants(artist) {
  const original = String(artist || "").replace(/\s+/g, " ").trim();
  if (!original) return [];

  const out = [];
  const push = (value) => {
    const next = String(value || "").replace(/\s+/g, " ").trim();
    if (next && !out.some((v) => v.toLowerCase() === next.toLowerCase())) {
      out.push(next);
    }
  };

  push(original);
  let s = original;
  // "Track Artist (feat. Guest)" / "[ft. Guest]"
  s = s
    .replace(
      /\s*[([]\s*(?:feat\.?|ft\.?|featuring|with)\b[^()[\]]*[)\]]\s*$/i,
      ""
    )
    .trim();
  push(s);
  // "Dr. Dre feat. Eminem" / "ft." / "featuring" / "with"
  s = s.replace(/\s+(?:feat\.?|ft\.?|featuring|with)\s+.+$/i, "").trim();
  push(s);
  // "Dr. Dre / Eminem" or "Dr. Dre/Eminem"
  const noSlash = s.replace(/\s*[|/]\s*.+$/, "").trim();
  push(noSlash);
  // "Dr. Dre, Eminem" (single comma, guest side has no & — keeps
  // "Earth, Wind & Fire" intact because the right side contains &).
  const comma = noSlash.match(/^(.+?),\s*([^,&|/]+)$/);
  if (comma) push(comma[1]);
  // "Dr. Dre & Eminem" / "and" — original is tried first, so real duo names
  // like "Simon & Garfunkel" keep their synced hit when it exists.
  push(noSlash.replace(/\s+(?:&|and)\s+.+$/i, ""));
  return out;
}

/**
 * Return unique artist strings to try when a punctuated band name misses.
 * Example: "Sixx:A.M." → ["Sixx:A.M.", "Sixx A.M.", "Sixx AM", "Sixx A M", "SixxAM"]
 */
export function artistLookupVariants(artist) {
  const bases = artistCreditVariants(artist);
  if (!bases.length) return [];

  const out = [];
  const push = (value) => {
    const next = String(value || "").replace(/\s+/g, " ").trim();
    if (next && !out.includes(next)) out.push(next);
  };

  for (const original of bases) {
    push(original);
    // Prefer spaced punctuation cleanup ("Sixx AM") before compacted forms.
    push(original.replace(/[:/\\|]+/g, " "));
    push(original.replace(/[:/\\|]+/g, " ").replace(/\./g, ""));
    push(original.replace(/[^\p{L}\p{N}]+/gu, " "));
    push(original.replace(/[.:]+/g, ""));
    push(original.replace(/[^\p{L}\p{N}]+/gu, ""));
  }
  return out;
}

// Trailing "(Remastered 2004)" / "[Live at Wembley]" style decorations. Only
// keyword-bearing parentheticals are stripped so legit titles like
// "Time (Clock of the Heart)" survive.
const TITLE_PAREN_DECORATION =
  /\s*[([][^()[\]]*\b(?:remaster(?:ed)?|live|acoustic|demo|mono|stereo|deluxe|expanded|edit|mix|version|single|radio|bonus|explicit|clean|anniversary|re-?record(?:ed)?|from|feat\.?|featuring|with)\b[^()[\]]*[)\]]\s*$/i;

/**
 * Title spellings to try when a decorated Spotify title misses. Providers
 * index "Peaches", but Sonos reports "Peaches - Remastered" — LRClib's search
 * returns zero rows for the suffixed form.
 * Example: "Peaches - Remastered" → ["Peaches - Remastered", "Peaches"]
 */
export function titleLookupVariants(title) {
  const original = String(title || "").replace(/\s+/g, " ").trim();
  if (!original) return [];

  const out = [];
  const push = (value) => {
    const next = String(value || "").replace(/\s+/g, " ").trim();
    if (next && !out.some((v) => v.toLowerCase() === next.toLowerCase())) {
      out.push(next);
    }
  };

  push(original);
  // Spotify appends version info after " - " ("Peaches - Remastered 2004").
  const noDashSuffix = original.replace(/\s+[-–—]\s+.*$/, "");
  push(noDashSuffix);
  let stripped = noDashSuffix;
  while (TITLE_PAREN_DECORATION.test(stripped)) {
    stripped = stripped.replace(TITLE_PAREN_DECORATION, "");
  }
  push(stripped);
  return out;
}
