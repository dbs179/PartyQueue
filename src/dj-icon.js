// DJ Voice icon store: host-uploaded icons under data/dj-icons/ (Docker-
// persisted). Keeps the newest few for quick reuse. null in settings means
// the seeded starter default (dj-icon-flat.png / public/dj-icons/flat.png).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { imageMatchesMime } from "./image-signature.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.join(__dirname, "..", "data", "dj-icons");
// Bundled starter icons ship in the image (public/); seeded into data/ on first use.
const STARTER_DIR = path.join(__dirname, "..", "public", "dj-icons");
// Legacy single-file location from the first DJ-icon pass.
const LEGACY_DATA_DIR = path.join(__dirname, "..", "data");

export const MAX_DJ_ICONS = 20;

// Stable gallery names for bundled styles (copied from public/dj-icons).
const STARTER_ICONS = [
  { src: "flat.png", dest: "dj-icon-flat.png" },
  { src: "retro.png", dest: "dj-icon-retro.png" },
  { src: "neon.png", dest: "dj-icon-neon.png" },
  { src: "cartoon.png", dest: "dj-icon-cartoon.png" },
  { src: "headphones.png", dest: "dj-icon-headphones.png" },
];
const STARTER_DEST = new Set(STARTER_ICONS.map((s) => s.dest));
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB decoded image cap

// Raster only — SVG uploads are rejected (scriptable if opened as a document).
// Bundled SVG art is not uploaded through this path.
const EXT_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const DJ_ICON_EXT = "png|jpg|webp|svg|gif";
// Preferred: dj-icon-flat.png. Still accept older dj-icon-1-flat.png forms.
const DJ_ICON_NAME_RE = new RegExp(
  `^dj-icon-(?:\\d+-)?[a-z][a-z0-9]*\\.(${DJ_ICON_EXT})$`,
  "i"
);

function ensureDir() {
  fs.mkdirSync(ICONS_DIR, { recursive: true });
}

// Only allow plain icon filenames we generated (no path traversal).
export function isSafeDjIconName(name) {
  return typeof name === "string" && DJ_ICON_NAME_RE.test(name);
}

function isLegacyDjIconName(name) {
  return typeof name === "string" && /^dj-icon\.(png|jpg|webp|svg|gif)$/i.test(name);
}

function isStarterDjIconName(name) {
  return STARTER_DEST.has(name);
}

// Move any leftover single-file icons into the gallery once.
// Returns a map of old filename → new gallery filename.
export function migrateLegacyIcons() {
  const renamed = new Map();
  try {
    if (!fs.existsSync(LEGACY_DATA_DIR)) return renamed;
    for (const name of fs.readdirSync(LEGACY_DATA_DIR)) {
      if (!isLegacyDjIconName(name)) continue;
      ensureDir();
      const ext = path.extname(name).slice(1).toLowerCase();
      const dest = `dj-icon-${Math.random().toString(36).slice(2, 10)}.${ext}`;
      try {
        fs.renameSync(path.join(LEGACY_DATA_DIR, name), path.join(ICONS_DIR, dest));
        renamed.set(name, dest);
      } catch (err) {
        console.error("[dj-icon] migrate failed:", err.message);
      }
    }
  } catch (err) {
    console.error("[dj-icon] migrate scan failed:", err.message);
  }
  return renamed;
}

/** Rename dj-icon-1-flat.png / dj-icon-123-holyroller.png → dj-icon-flat.png etc. */
export function migrateDjIconFilenames() {
  const renamed = new Map();
  try {
    if (!fs.existsSync(ICONS_DIR)) return renamed;
    ensureDir();
    for (const name of fs.readdirSync(ICONS_DIR)) {
      const m = /^dj-icon-(?:\d+-)?([a-z][a-z0-9]*)\.(png|jpg|webp|svg|gif)$/i.exec(
        name
      );
      if (!m) continue;
      const dest = `dj-icon-${m[1].toLowerCase()}.${m[2].toLowerCase()}`;
      if (dest === name) continue;
      const from = path.join(ICONS_DIR, name);
      const to = path.join(ICONS_DIR, dest);
      try {
        if (fs.existsSync(to)) {
          fs.unlinkSync(from);
        } else {
          fs.renameSync(from, to);
        }
        renamed.set(name, dest);
      } catch (err) {
        console.error("[dj-icon] rename failed:", err.message);
      }
    }
  } catch (err) {
    console.error("[dj-icon] rename scan failed:", err.message);
  }
  return renamed;
}

export function djIconPath(name) {
  return isSafeDjIconName(name) ? path.join(ICONS_DIR, name) : null;
}

export function djIconExists(name) {
  const p = djIconPath(name);
  return !!(p && fs.existsSync(p));
}

// Copy any missing bundled starter icons into data/. Never overwrites.
export function seedStarterDjIcons() {
  try {
    if (!fs.existsSync(STARTER_DIR)) return 0;
    ensureDir();
    let copied = 0;
    for (const { src, dest } of STARTER_ICONS) {
      const from = path.join(STARTER_DIR, src);
      const to = path.join(ICONS_DIR, dest);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.copyFileSync(from, to);
      copied += 1;
    }
    if (copied) console.log(`[dj-icon] seeded ${copied} starter icon(s)`);
    return copied;
  } catch (err) {
    console.error("[dj-icon] seed failed:", err.message);
    return 0;
  }
}

// Icon files newest-first, each as { name, url }.
export function listDjIcons() {
  try {
    seedStarterDjIcons();
    ensureDir();
    return fs
      .readdirSync(ICONS_DIR)
      .filter(isSafeDjIconName)
      .map((name) => ({
        name,
        mtime: fs.statSync(path.join(ICONS_DIR, name)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .map(({ name }) => ({
        name,
        url: `/dj-icon/${name}`,
        starter: isStarterDjIconName(name),
      }));
  } catch (err) {
    console.error("[dj-icon] list failed:", err.message);
    return [];
  }
}

// Delete everything except the newest MAX_DJ_ICONS, always protecting keepName
// and bundled starters.
function prune(keepName) {
  const all = listDjIcons().map((b) => b.name);
  const keep = new Set(all.slice(0, MAX_DJ_ICONS));
  if (keepName && djIconExists(keepName)) keep.add(keepName);
  for (const name of STARTER_DEST) {
    if (djIconExists(name)) keep.add(name);
  }
  for (const name of all) {
    if (!keep.has(name)) {
      try {
        fs.unlinkSync(path.join(ICONS_DIR, name));
      } catch (err) {
        console.error("[dj-icon] prune failed:", err.message);
      }
    }
  }
}

// Decode + persist a data-URL image, returning the stored filename.
export function saveDjIcon(dataUrl) {
  const m = /^data:([a-z0-9/+.-]+);base64,(.+)$/is.exec(String(dataUrl || "").trim());
  if (!m) throw new Error("Expected a base64 image data URL.");
  const mime = m[1].toLowerCase();
  if (mime === "image/svg+xml") {
    throw new Error("SVG uploads are not allowed. Use PNG, JPG, WEBP or GIF.");
  }
  const ext = EXT_BY_MIME[mime];
  if (!ext) throw new Error("Unsupported image type. Use PNG, JPG, WEBP or GIF.");

  const buf = Buffer.from(m[2], "base64");
  if (!buf.length) throw new Error("Image data was empty.");
  if (buf.length > MAX_BYTES) throw new Error("Image is too large (2 MB max).");
  if (!imageMatchesMime(buf, mime)) {
    throw new Error("Image data does not match its declared type.");
  }

  ensureDir();
  const name = `dj-icon-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  fs.writeFileSync(path.join(ICONS_DIR, name), buf);
  prune(name);
  return name;
}

// Remove one icon; returns true if it existed. Bundled starters cannot be deleted.
export function deleteDjIcon(name) {
  if (!djIconExists(name)) return false;
  if (isStarterDjIconName(name)) {
    throw new Error("Built-in starter icons can’t be deleted.");
  }
  try {
    fs.unlinkSync(path.join(ICONS_DIR, name));
    return true;
  } catch (err) {
    console.error("[dj-icon] delete failed:", err.message);
    return false;
  }
}
