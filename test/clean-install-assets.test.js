import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DJ_SILENCE_OPTIONS } from "../src/settings.js";
import { syncSilencePadFiles } from "../src/dj-voice.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

test("clean installs include every DJ handoff silence asset", () => {
  for (const duration of DJ_SILENCE_OPTIONS) {
    const file = path.join(
      repoRoot,
      "public",
      `dj-silence-${duration}s.mp3`
    );
    assert.ok(fs.existsSync(file), `missing ${path.basename(file)}`);
    assert.ok(fs.statSync(file).size > 100, `${path.basename(file)} is empty`);
  }
});

test("an empty data directory is seeded from bundled silence assets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pq-clean-install-"));
  const ttsDir = path.join(root, "data", "tts");
  try {
    syncSilencePadFiles({
      publicDir: path.join(repoRoot, "public"),
      ttsDir,
    });
    for (const duration of DJ_SILENCE_OPTIONS) {
      assert.ok(
        fs.statSync(path.join(ttsDir, `silence-${duration}s.mp3`)).size > 100
      );
      assert.ok(
        fs.statSync(path.join(ttsDir, `silence-ramp-${duration}s.mp3`)).size >
          100
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
