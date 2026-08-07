/**
 * Bundle the PartyQueue browser entry (main.js → app.js + helpers) into one
 * ESM file under public/js/dist/. Same UI behavior; smaller deploy surface and
 * a place to land future app.js splits.
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "public", "js", "main.js");
const outdir = path.join(root, "public", "js", "dist");
const outfile = path.join(outdir, "main.js");

fs.mkdirSync(outdir, { recursive: true });

const minify = process.env.PQ_CLIENT_MINIFY !== "0";

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  outfile,
  minify,
  sourcemap: true,
  logLevel: "info",
});

const { size } = fs.statSync(outfile);
console.log(
  `[build:client] wrote ${path.relative(root, outfile)} (${(size / 1024).toFixed(1)} KB)` +
    (minify ? ", minified" : "")
);
