// Hero-banner store: keeps host-uploaded banners on disk (under data/, so they
// survive restarts and ride the Docker volume) and retains only the most recent
// few for quick reuse. Images arrive as data URLs from the Settings page; we
// validate the type/size, write a fresh file, and prune older ones.
// Bundled starters live in public/banners/ and are seeded into data/ when missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANNERS_DIR = path.join(__dirname, "..", "data", "banners");
const STARTER_DIR = path.join(__dirname, "..", "public", "banners");

export const MAX_BANNERS = 20;
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB decoded image cap

// Bundled defaults (public/banners → data/banners). hero.png remains the
// true app Default (null); these are extra gallery choices.
const STARTER_BANNERS = [
  { src: "vinyl.jpg", dest: "banner-vinyl.jpg" },
  { src: "speakers.jpg", dest: "banner-speakers.jpg" },
  { src: "backyard.jpg", dest: "banner-backyard.jpg" },
  { src: "karaoke.jpg", dest: "banner-karaoke.jpg" },
  { src: "records.jpg", dest: "banner-records.jpg" },
];
const STARTER_DEST = new Set(STARTER_BANNERS.map((s) => s.dest));

// Older banner-1-starterNN.* names → descriptive slugs (incl. retired starters).
const LEGACY_STARTER_SLUGS = {
  "01": "vinyl",
  "02": "speakers",
  "03": "backyard",
  "04": "karaoke",
  "05": "records",
  "06": "kitchen",
  "07": "acoustic",
  "08": "dancefloor",
  "09": "jukebox",
  "10": "rooftop",
};

const BANNER_EXT = "png|jpg|webp|gif";
// Preferred: banner-vinyl.jpg. Still accept older banner-1-starter01.jpg /
// banner-1784…-6kwgfm.png forms during migration.
const BANNER_NAME_RE = new RegExp(
  `^banner-(?:\\d+-)?[a-z0-9]+\\.(${BANNER_EXT})$`,
  "i"
);

// Accepted image types mapped to the extension we store them as.
const EXT_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function ensureDir() {
  fs.mkdirSync(BANNERS_DIR, { recursive: true });
}

// Only allow plain banner filenames we generated (no path traversal).
export function isSafeBannerName(name) {
  return typeof name === "string" && BANNER_NAME_RE.test(name);
}

function isSafeName(name) {
  return isSafeBannerName(name);
}

function isStarterBannerName(name) {
  return STARTER_DEST.has(name);
}

/** Rename banner-1-starter02.jpg / banner-123-choir1.png → banner-speakers.jpg etc. */
export function migrateBannerFilenames() {
  const renamed = new Map();
  try {
    if (!fs.existsSync(BANNERS_DIR)) return renamed;
    ensureDir();
    for (const name of fs.readdirSync(BANNERS_DIR)) {
      let dest = null;
      const starter = /^banner-1-starter(\d+)\.(png|jpg|webp|gif)$/i.exec(name);
      if (starter) {
        const slug = LEGACY_STARTER_SLUGS[starter[1].padStart(2, "0")] ||
          LEGACY_STARTER_SLUGS[starter[1]];
        if (slug) dest = `banner-${slug}.${starter[2].toLowerCase()}`;
      } else {
        const m = /^banner-(\d+)-([a-z0-9]+)\.(png|jpg|webp|gif)$/i.exec(name);
        if (m) dest = `banner-${m[2].toLowerCase()}.${m[3].toLowerCase()}`;
      }
      if (!dest || dest === name) continue;
      const from = path.join(BANNERS_DIR, name);
      const to = path.join(BANNERS_DIR, dest);
      try {
        if (fs.existsSync(to)) {
          fs.unlinkSync(from);
        } else {
          fs.renameSync(from, to);
        }
        renamed.set(name, dest);
      } catch (err) {
        console.error("[banners] rename failed:", err.message);
      }
    }
  } catch (err) {
    console.error("[banners] rename scan failed:", err.message);
  }
  return renamed;
}

/** Copy any missing bundled starter banners into data/. Never overwrites. */
export function seedStarterBanners() {
  try {
    if (!fs.existsSync(STARTER_DIR)) return 0;
    ensureDir();
    let copied = 0;
    for (const { src, dest } of STARTER_BANNERS) {
      const from = path.join(STARTER_DIR, src);
      const to = path.join(BANNERS_DIR, dest);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.copyFileSync(from, to);
      copied += 1;
    }
    if (copied) console.log(`[banners] seeded ${copied} starter banner(s)`);
    return copied;
  } catch (err) {
    console.error("[banners] seed failed:", err.message);
    return 0;
  }
}

// Banner files newest-first, each as { name, url, starter }.
export function listBanners() {
  try {
    migrateBannerFilenames();
    seedStarterBanners();
    ensureDir();
    return fs
      .readdirSync(BANNERS_DIR)
      .filter(isSafeName)
      .map((name) => ({
        name,
        mtime: fs.statSync(path.join(BANNERS_DIR, name)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .map(({ name }) => ({
        name,
        url: `/banners/${name}`,
        starter: isStarterBannerName(name),
      }));
  } catch (err) {
    console.error("[banners] list failed:", err.message);
    return [];
  }
}

export function bannerExists(name) {
  return isSafeName(name) && fs.existsSync(path.join(BANNERS_DIR, name));
}

export function bannerPath(name) {
  return isSafeName(name) ? path.join(BANNERS_DIR, name) : null;
}

// Delete everything except the newest MAX_BANNERS, always protecting `keepName`
// (the active banner) and bundled starters.
function prune(keepName) {
  const all = listBanners().map((b) => b.name);
  const keep = new Set(all.slice(0, MAX_BANNERS));
  if (keepName && bannerExists(keepName)) keep.add(keepName);
  for (const name of STARTER_DEST) {
    if (bannerExists(name)) keep.add(name);
  }
  for (const name of all) {
    if (!keep.has(name)) {
      try {
        fs.unlinkSync(path.join(BANNERS_DIR, name));
      } catch (err) {
        console.error("[banners] prune failed:", err.message);
      }
    }
  }
}

// Decode + persist a data-URL image, returning the stored filename. Throws on
// an unsupported type or oversized payload.
export function saveBanner(dataUrl) {
  const m = /^data:([a-z0-9/+.-]+);base64,(.+)$/is.exec(String(dataUrl || "").trim());
  if (!m) throw new Error("Expected a base64 image data URL.");
  const ext = EXT_BY_MIME[m[1].toLowerCase()];
  if (!ext) throw new Error("Unsupported image type. Use PNG, JPG, WEBP or GIF.");

  const buf = Buffer.from(m[2], "base64");
  if (!buf.length) throw new Error("Image data was empty.");
  if (buf.length > MAX_BYTES) throw new Error("Image is too large (8 MB max).");

  ensureDir();
  const name = `banner-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  fs.writeFileSync(path.join(BANNERS_DIR, name), buf);
  prune(name);
  return name;
}

// Remove one banner; returns true if it existed. Bundled starters cannot be deleted.
export function deleteBanner(name) {
  if (!bannerExists(name)) return false;
  if (isStarterBannerName(name)) {
    throw new Error("Built-in starter banners can’t be deleted.");
  }
  try {
    fs.unlinkSync(path.join(BANNERS_DIR, name));
    return true;
  } catch (err) {
    console.error("[banners] delete failed:", err.message);
    return false;
  }
}
