import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(".");

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

test(
  "share package is allow-listed and contains no credential artifacts",
  { skip: process.platform !== "win32" },
  () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pq-share-test-"));
    const outDir = path.join(temp, "out");
    const expanded = path.join(temp, "expanded");
    const traps = [
      path.join(ROOT, ".env.package-test"),
      path.join(ROOT, ".tmp-package-test.txt"),
      path.join(ROOT, ".override-package-test.txt"),
    ];

    try {
      fs.writeFileSync(traps[0], "HA_TOKEN=must-not-ship\n", "utf8");
      fs.writeFileSync(traps[1], "Authorization: Bearer must-not-ship\n", "utf8");
      fs.writeFileSync(traps[2], "local diagnostics\n", "utf8");

      const packaged = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(ROOT, "scripts", "package-share.ps1"),
          "-OutDir",
          outDir,
        ],
        { cwd: ROOT, encoding: "utf8" }
      );
      assert.equal(
        packaged.status,
        0,
        `package-share failed:\n${packaged.stdout}\n${packaged.stderr}`
      );

      const zips = fs.readdirSync(outDir).filter((name) => name.endsWith(".zip"));
      assert.equal(zips.length, 1);
      const zipPath = path.join(outDir, zips[0]);
      const expandedResult = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "Expand-Archive -LiteralPath $env:PQ_TEST_ZIP -DestinationPath $env:PQ_TEST_EXPANDED -Force",
        ],
        {
          cwd: ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            PQ_TEST_ZIP: zipPath,
            PQ_TEST_EXPANDED: expanded,
          },
        }
      );
      assert.equal(
        expandedResult.status,
        0,
        `archive expansion failed:\n${expandedResult.stdout}\n${expandedResult.stderr}`
      );

      const files = walkFiles(expanded);
      const relative = files.map((file) =>
        path.relative(expanded, file).replaceAll("\\", "/")
      );
      const forbiddenSegments = new Set([
        "data",
        "node_modules",
        ".git",
        ".cursor",
        "test-results",
        "playwright-report",
      ]);
      const hasForbiddenPath = (name) =>
        name.split("/").some(
          (segment) =>
            forbiddenSegments.has(segment.toLowerCase()) ||
            segment === ".env" ||
            (segment.toLowerCase().startsWith(".env.") &&
              segment.toLowerCase() !== ".env.example") ||
            segment.toLowerCase().startsWith(".tmp-") ||
            segment.toLowerCase().startsWith(".override-")
        );
      assert.deepEqual(relative.filter(hasForbiddenPath), []);

      const allowedRoots = new Set([
        ".dockerignore",
        ".env.example",
        ".github",
        ".gitignore",
        "docker-compose.yml",
        "Dockerfile",
        "e2e",
        "LICENSE",
        "package-lock.json",
        "package.json",
        "playwright.config.mjs",
        "public",
        "README.md",
        "scripts",
        "src",
        "test",
      ]);
      assert.deepEqual(
        [...new Set(relative.map((name) => name.split("/", 1)[0]))].filter(
          (name) => !allowedRoots.has(name)
        ),
        []
      );

      const credentialPattern =
        /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/;
      const hits = files
        .filter((file) => fs.statSync(file).size <= 5_000_000)
        .filter((file) => credentialPattern.test(fs.readFileSync(file, "utf8")))
        .map((file) => path.relative(expanded, file));
      assert.deepEqual(hits, []);

      const installationMarkers = [
        ["CeNX9CMw", "mxDxUF5Q2Inm"].join(""),
        ["Holy", " Roller"].join(""),
        ["David", " Swineford"].join(""),
        ["Henri", " Music"].join(""),
        ["Owen", "'s Minecraft"].join(""),
      ];
      const personalizedHits = files
        .filter((file) => fs.statSync(file).size <= 5_000_000)
        .filter((file) => {
          const content = fs.readFileSync(file, "utf8");
          return installationMarkers.some((marker) => content.includes(marker));
        })
        .map((file) => path.relative(expanded, file));
      assert.deepEqual(personalizedHits, []);
    } finally {
      for (const trap of traps) fs.rmSync(trap, { force: true });
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
);
