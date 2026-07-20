// Crash-safe file writes.
//
// Write to a temp file in the same directory, then rename it over the target.
// Rename is atomic on a single filesystem (libuv uses MoveFileEx with
// REPLACE_EXISTING on Windows and rename() on POSIX), so a power loss, kill, or
// crash mid-write can never leave a half-written file: the target is always
// either the complete OLD contents or the complete NEW ones. Used by every JSON
// store so an unclean shutdown (common on an always-on box) can't corrupt
// settings, the Spotify token, play history, etc.

import fs from "node:fs";
import path from "node:path";

export function writeFileAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Unique temp name so two writers (or a leftover from a crash) can't collide.
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup; ignore */
    }
    throw err;
  }
}
