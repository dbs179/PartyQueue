#!/usr/bin/env node
/**
 * Show, enable or restore DJ Voice around a live smoke run. The announce
 * smokes need it on; the host may deliberately have it off, so the previous
 * value is saved to disk before anything changes.
 *
 *   node scripts/smoke-dj-toggle.mjs show
 *   node scripts/smoke-dj-toggle.mjs enable
 *   node scripts/smoke-dj-toggle.mjs restore
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { api, ensureHostAuth } from "./smoke-lib.mjs";

const STATE_FILE = new URL("../.smoke-dj-state.json", import.meta.url);
const FIELDS = ["djVoiceEnabled", "djShoutOutsEnabled", "djBanterEnabled"];

await ensureHostAuth();
const settings = await api("GET", "/api/settings");
const current = Object.fromEntries(
  FIELDS.filter((f) => f in settings).map((f) => [f, settings[f]])
);

const mode = process.argv[2];
if (mode === "show") {
  const all = Object.fromEntries(
    Object.entries(settings).filter(([k]) =>
      /dj|shout|announce|voice|banter|holy|sister/i.test(k)
    )
  );
  console.log(JSON.stringify(all, null, 2));
} else if (mode === "enable") {
  if (!existsSync(STATE_FILE)) {
    writeFileSync(STATE_FILE, JSON.stringify(current, null, 2));
    console.log("saved:", JSON.stringify(current));
  }
  const on = Object.fromEntries(Object.keys(current).map((f) => [f, true]));
  await api("POST", "/api/settings", on);
  console.log("enabled:", JSON.stringify(on));
} else if (mode === "restore") {
  if (!existsSync(STATE_FILE)) {
    console.log("no saved DJ state; leaving settings alone");
  } else {
    const saved = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    await api("POST", "/api/settings", saved);
    console.log("restored:", JSON.stringify(saved));
    rmSync(STATE_FILE, { force: true });
  }
} else {
  console.error("usage: smoke-dj-toggle.mjs <show|enable|restore>");
  process.exit(2);
}

const after = await api("GET", "/api/settings");
console.log(
  "now:",
  JSON.stringify(
    Object.fromEntries(FIELDS.filter((f) => f in after).map((f) => [f, after[f]]))
  )
);
