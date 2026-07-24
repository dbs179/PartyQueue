import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function source(file) {
  return fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

/** Concatenated source of every route module in src/routes/. */
function routesSource() {
  const dir = new URL("../src/routes/", import.meta.url);
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => fs.readFileSync(new URL(name, dir), "utf8"))
    .join("\n");
}

test("runtime security boundaries do not serialize authentication secrets", () => {
  const server = source("src/server.js");
  const routes = routesSource();
  const spotify = source("src/spotify.js");
  const voice = source("src/dj-voice.js");

  assert.doesNotMatch(server, /First-time host setup code:\s*\$\{/);
  assert.doesNotMatch(routes, /json\(\{[^}]*\btoken\b/s);
  assert.doesNotMatch(routes, /Could not connect Spotify:\s*\$\{/);
  assert.doesNotMatch(spotify, /const detail = await res\.text\(\)/);
  assert.doesNotMatch(voice, /saved \$\{clip\.fileName\}[^`\n]*clip\.publicUrl/);
});
