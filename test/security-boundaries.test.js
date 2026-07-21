import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function source(file) {
  return fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

test("runtime security boundaries do not serialize authentication secrets", () => {
  const server = source("src/server.js");
  const routes = source("src/routes/api.js");
  const spotify = source("src/spotify.js");
  const voice = source("src/dj-voice.js");

  assert.doesNotMatch(server, /First-time host setup code:\s*\$\{/);
  assert.doesNotMatch(routes, /json\(\{[^}]*\btoken\b/s);
  assert.doesNotMatch(routes, /Could not connect Spotify:\s*\$\{/);
  assert.doesNotMatch(spotify, /const detail = await res\.text\(\)/);
  assert.doesNotMatch(voice, /saved \$\{clip\.fileName\}[^`\n]*clip\.publicUrl/);
});
