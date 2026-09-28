/**
 * Bundle the PartyQueue browser entry into public/js/dist/.
 * Guest code stays in main.js. Booth, DJ, connections, and stats load as
 * separate chunks the first time those screens open.
 *
 *   node scripts/build-client.mjs           # one-shot
 *   node scripts/build-client.mjs --watch   # rebuild on public/js changes
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "public", "js", "main.js");
const outdir = path.join(root, "public", "js", "dist");
const outfile = path.join(outdir, "main.js");
const watch = process.argv.includes("--watch");

fs.mkdirSync(outdir, { recursive: true });

// Watch builds stay readable; production/start minify unless overridden.
const minify = watch
  ? process.env.PQ_CLIENT_MINIFY === "1"
  : process.env.PQ_CLIENT_MINIFY !== "0";

const buildOptions = {
  entryPoints: [entry],
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  outdir,
  entryNames: "[name]",
  chunkNames: "chunk-[hash]",
  minify,
  sourcemap: true,
  logLevel: "info",
};

function logBundle() {
  const files = fs
    .readdirSync(outdir)
    .filter((name) => name.endsWith(".js"));
  const lines = files.map((name) => {
    const { size } = fs.statSync(path.join(outdir, name));
    return `${name} (${(size / 1024).toFixed(1)} KB)`;
  });
  console.log(
    `[build:client] wrote ${lines.join(", ")}` +
      (minify ? ", minified" : ", watch")
  );
  const main = fs.readFileSync(outfile, "utf8");
  if (main.includes("dj-stat-banner")) {
    throw new Error(
      "[build:client] guest bundle still contains the DJ booth UI"
    );
  }
  const booth = files
    .filter((name) => name.startsWith("chunk-"))
    .map((name) => fs.readFileSync(path.join(outdir, name), "utf8"))
    .some((source) => source.includes("dj-stat-banner"));
  if (!booth) {
    throw new Error("[build:client] DJ booth UI was not split into a chunk");
  }
}

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  logBundle();
  console.log("[build:client] watching public/js for changes…");
} else {
  await esbuild.build(buildOptions);
  logBundle();
}
