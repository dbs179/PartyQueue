#!/usr/bin/env node
/**
 * Generate 4–5 DJ set announces back to back and lint the copy.
 * Does not touch Sonos, the live queue, TTS, or playback.
 *
 * Uses an isolated DJ-memory file so live phrase reservations stay intact.
 *
 *   npm run smoke:announce-copy
 *   node --env-file-if-exists=.env scripts/smoke-announce-copy.mjs
 *   PQ_ANNOUNCE_COUNT=5 node --env-file-if-exists=.env scripts/smoke-announce-copy.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const COUNT = Math.max(
  4,
  Math.min(8, Math.floor(Number(process.env.PQ_ANNOUNCE_COUNT) || 5))
);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pq-announce-copy-"));
const memoryFile = path.join(tmpDir, "dj-night-memory.json");
process.env.PARTYQUEUE_DJ_MEMORY_FILE = memoryFile;

const { writeSetScript } = await import("../src/dj-voice.js");
const { isHaConfigured } = await import("../src/home-assistant.js");
const { lintAnnounceBatch } = await import("../src/dj-announce-copy-lint.js");

const BATCHES = [
  {
    event: "session_start",
    count: 5,
    discoveryEnabled: true,
    similarAdded: 1,
    highlights: [
      { artist: "HARDY", name: "One Beer" },
      { artist: "Shinedown", name: "Fly from the Inside" },
      { artist: "Charlie Puth", name: "Marvin Gaye", discovered: true },
      { artist: "The HU", name: "Lost Soul" },
      { artist: "Foo Fighters", name: "Everlong" },
    ],
  },
  {
    event: "session_refill",
    count: 5,
    discoveryEnabled: false,
    similarAdded: 0,
    highlights: [
      { artist: "Prince", name: "Kiss" },
      { artist: "Journey", name: "Don't Stop Believin'" },
      { artist: "Taylor Swift", name: "Shake It Off" },
      { artist: "AC/DC", name: "T.N.T." },
      { artist: "Luke Combs", name: "Hurricane" },
    ],
  },
  {
    event: "session_refill",
    count: 5,
    discoveryEnabled: true,
    similarAdded: 1,
    highlights: [
      { artist: "The Weeknd", name: "Blinding Lights" },
      { artist: "Dua Lipa", name: "Don't Start Now", discovered: true },
      { artist: "Bruno Mars", name: "Uptown Funk" },
      { artist: "Lady Gaga", name: "Just Dance" },
      { artist: "The Killers", name: "Mr. Brightside" },
    ],
  },
  {
    event: "session_refill",
    count: 5,
    discoveryEnabled: false,
    similarAdded: 0,
    highlights: [
      { artist: "Morgan Wallen", name: "Cowgirls" },
      { artist: "Zach Bryan", name: "Something in the Orange" },
      { artist: "Chris Stapleton", name: "Tennessee Whiskey" },
      { artist: "Carrie Underwood", name: "Before He Cheats" },
      { artist: "Keith Urban", name: "Blue Ain't Your Color" },
    ],
  },
  {
    event: "session_refill",
    count: 5,
    discoveryEnabled: true,
    similarAdded: 1,
    highlights: [
      { artist: "Queen", name: "Don't Stop Me Now" },
      { artist: "Bon Jovi", name: "Livin' on a Prayer" },
      { artist: "Guns N' Roses", name: "Sweet Child O' Mine", discovered: true },
      { artist: "Def Leppard", name: "Pour Some Sugar on Me" },
      { artist: "Van Halen", name: "Jump" },
    ],
  },
];

function captureScriptSource() {
  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => {
    const text = args.map(String).join(" ");
    if (/\[dj-voice\] script via/.test(text)) lines.push(text);
    origLog(...args);
  };
  console.error = (...args) => origErr(...args);
  return {
    lines,
    async done(promise) {
      try {
        return await promise;
      } finally {
        console.log = origLog;
        console.error = origErr;
      }
    },
  };
}

function sourceFromLogs(logs) {
  const line = logs.find((l) => /\[dj-voice\] script via/.test(l)) || "";
  if (/OpenAI conversation/i.test(line)) return "llm";
  if (/template/i.test(line)) return "template";
  return "unknown";
}

function printIssue(issue) {
  const tag = issue.severity === "fail" ? "FAIL" : "warn";
  console.log(`    [${tag}] ${issue.id}: ${issue.detail}`);
}

async function main() {
  console.log("smoke-announce-copy: script only — no TTS, queue, or playback");
  console.log(`isolated DJ memory: ${memoryFile}`);
  if (!isHaConfigured()) {
    throw new Error(
      "Home Assistant is not configured. This smoke needs the OpenAI conversation agent to draft live copy."
    );
  }

  const scripts = [];
  const sources = [];
  for (let i = 0; i < COUNT; i++) {
    const batch = BATCHES[i % BATCHES.length];
    const cap = captureScriptSource();
    const script = await cap.done(
      writeSetScript({
        ...batch,
        skipNextSetPack: true,
      })
    );
    const source = sourceFromLogs(cap.lines);
    sources.push(source);
    scripts.push(String(script || "").trim());
    console.log(`\n--- announce ${i + 1}/${COUNT} (${batch.event}, ${source}) ---`);
    console.log(scripts[i] || "(empty)");
  }

  const report = lintAnnounceBatch(scripts);
  console.log("\n=== copy analysis ===");
  for (const row of report.perScript) {
    const fails = row.issues.filter((i) => i.severity === "fail");
    const warns = row.issues.filter((i) => i.severity === "warn");
    if (!fails.length && !warns.length) {
      console.log(`announce ${row.index + 1}: clean`);
      continue;
    }
    console.log(`announce ${row.index + 1}:`);
    for (const issue of row.issues) printIssue(issue);
  }
  if (report.repeats.length) {
    console.log("repeats:");
    for (const issue of report.repeats) printIssue(issue);
  } else {
    console.log("repeats: none");
  }

  const llmCount = sources.filter((s) => s === "llm").length;
  const templateCount = sources.filter((s) => s === "template").length;
  console.log(
    `\nsources: ${llmCount} llm, ${templateCount} template, ${COUNT - llmCount - templateCount} unknown`
  );
  console.log(`issues: ${report.failCount} fail, ${report.warnCount} warn`);

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  if (llmCount === 0) {
    throw new Error(
      "Every announce fell back to templates — LLM copy was not exercised."
    );
  }
  if (report.failCount > 0) {
    throw new Error(`Announce copy smoke failed (${report.failCount} issue(s)).`);
  }
  console.log("PASS smoke-announce-copy");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
