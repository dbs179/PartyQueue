// One-shot: remap stored tags to top-2 buckets, then re-fetch legacy
// bucket-only artists from Last.fm. Run from repo root with .env present:
//   node --env-file-if-exists=.env scripts/refresh-genre-top2.mjs

import {
  remapGenreCacheInPlace,
  warmGenresFromPool,
  flushGenrePersist,
  needsGenreFetch,
} from "../src/genres.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cacheFile =
  process.env.PARTYQUEUE_GENRE_CACHE_FILE ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "genre-cache.json");

const before = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
const artists = before.artists || before;
const legacy = Object.keys(artists).filter((k) => needsGenreFetch(k));
const remapped = remapGenreCacheInPlace();
flushGenrePersist();
console.log(
  `[refresh-genre-top2] remapped=${remapped} legacyFetchNeeded=${legacy.length}`
);
console.log("[refresh-genre-top2] warming pool + legacy artists from Last.fm...");
await warmGenresFromPool();
flushGenrePersist();
const after = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
const m = (after.artists || after).marshmello;
console.log("[refresh-genre-top2] marshmello after:", JSON.stringify(m));
console.log("[refresh-genre-top2] done");
