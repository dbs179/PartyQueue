// Read/update a local .env file without wiping unrelated keys.
// Used by Settings → Save so API credentials land in .env (gitignored).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENV = path.join(__dirname, "..", ".env");

export function envFilePath() {
  return process.env.PARTYQUEUE_ENV_FILE?.trim() || DEFAULT_ENV;
}

function quoteIfNeeded(value) {
  const s = String(value);
  if (/[\s#"']/.test(s) || s === "") return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return s;
}

function parseLine(line) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) return null;
  let val = m[2].trim();
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1);
  }
  return { key: m[1], value: val, raw: line };
}

// Upsert keys into .env. Creates the file if missing. Leaves other lines alone
// (including comments and blank lines). Values of `null` / `undefined` remove
// that key's assignment line.
export function upsertEnvKeys(updates = {}) {
  const file = envFilePath();
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    text = "";
  }

  const lines = text.length ? text.split(/\r?\n/) : [];
  const seen = new Set();
  const next = [];

  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed || !Object.prototype.hasOwnProperty.call(updates, parsed.key)) {
      next.push(line);
      continue;
    }
    seen.add(parsed.key);
    const value = updates[parsed.key];
    if (value === null || value === undefined || value === "") {
      // drop the line (clear)
      continue;
    }
    next.push(`${parsed.key}=${quoteIfNeeded(value)}`);
  }

  for (const [key, value] of Object.entries(updates)) {
    if (seen.has(key)) continue;
    if (value === null || value === undefined || value === "") continue;
    next.push(`${key}=${quoteIfNeeded(value)}`);
  }

  // Avoid a trailing blank-only file looking weird; keep a final newline.
  let out = next.join("\n");
  if (out && !out.endsWith("\n")) out += "\n";
  writeFileAtomic(file, out);
  return file;
}
