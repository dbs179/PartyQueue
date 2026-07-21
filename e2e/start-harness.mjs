/**
 * Long-lived HTTP harness for Playwright (no Spotify warm, no signal handlers).
 * Stays up until the process is killed by Playwright's webServer lifecycle.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), `pq-browser-${process.pid}-`)
);
process.env.PARTYQUEUE_SETTINGS_FILE = path.join(tmpRoot, "settings.json");
process.env.PARTYQUEUE_HOST_PIN_FILE = path.join(tmpRoot, "host-pin.json");
process.env.PARTYQUEUE_HISTORY_FILE = path.join(tmpRoot, "history.json");
process.env.PARTYQUEUE_COOLDOWN_FILE = path.join(tmpRoot, "cooldowns.json");
process.env.PARTYQUEUE_REQUESTS_FILE = path.join(tmpRoot, "requests.json");
process.env.PARTYQUEUE_REACTIONS_FILE = path.join(tmpRoot, "reactions.json");
process.env.PARTYQUEUE_SUGGESTIONS_FILE = path.join(tmpRoot, "suggestions.json");
process.env.PARTYQUEUE_GUESTS_FILE = path.join(tmpRoot, "guests.json");
process.env.PARTYQUEUE_ORIGIN_FILE = path.join(tmpRoot, "origins.json");
process.env.PARTYQUEUE_DJ_MEMORY_FILE = path.join(tmpRoot, "dj-memory.json");
delete process.env.SETTINGS_PIN;

const { startServer, shutdownServer } = await import("../src/server.js");

const runtime = startServer({
  port: 18088,
  host: "127.0.0.1",
  signals: false,
  seed: false,
  warm: false,
  exit() {},
});
if (!runtime.httpServer.listening) {
  await once(runtime.httpServer, "listening");
}

const stop = async () => {
  await shutdownServer({ reason: "browser harness stop", exit: false });
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
