// Routes all bare console.* output through the same redaction — and, with
// LOG_FORMAT=json, the same one-JSON-object-per-line formatting — as the
// structured logger in logger.js. The codebase still has ~180 legacy
// console.error("[scope] message", detail) call sites; this bridge means none
// of them can leak credentials into logs or break a JSON log pipeline. New
// code should still prefer createLogger().

import { inspect } from "node:util";
import { logFormatIsJson, redactString, redactValue } from "./logger.js";

const LEVELS = {
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
};

// Legacy call sites tag output like "[queue/remove] message" — reuse that as
// the JSON scope so grepping by subsystem keeps working.
const SCOPE_RE = /^\[([\w./ :-]+)\]\s*/;

function renderArg(arg) {
  if (typeof arg === "string") return redactString(arg);
  return inspect(redactValue(arg), { depth: 5 });
}

/**
 * Replace the global console methods. Returns a restore function (for tests).
 *
 * @param {{ json?: boolean, sink?: Pick<Console, "log"|"info"|"warn"|"error"|"debug"> }} [options]
 */
export function installConsoleBridge(options = {}) {
  const json = options.json ?? logFormatIsJson();
  const original = {};
  const defaultSink = {};
  for (const method of Object.keys(LEVELS)) {
    original[method] = console[method];
    defaultSink[method] = console[method].bind(console);
  }
  const sink = options.sink || defaultSink;

  for (const [method, level] of Object.entries(LEVELS)) {
    console[method] = (...args) => {
      // Lines from the structured logger's JSON mode are already redacted and
      // formatted — pass them through untouched.
      if (
        json &&
        args.length === 1 &&
        typeof args[0] === "string" &&
        args[0].startsWith('{"ts":')
      ) {
        sink[method](args[0]);
        return;
      }

      let text = args.map(renderArg).join(" ");
      if (!json) {
        sink[method](text);
        return;
      }

      let scope = "console";
      const tagged = text.match(SCOPE_RE);
      if (tagged) {
        scope = tagged[1];
        text = text.slice(tagged[0].length);
      }
      sink[method](
        JSON.stringify({
          ts: new Date().toISOString(),
          level,
          scope,
          msg: text,
        })
      );
    };
  }

  return function restoreConsole() {
    for (const method of Object.keys(LEVELS)) {
      console[method] = original[method];
    }
  };
}
