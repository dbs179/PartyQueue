// DJ Voice icon store: host-uploaded icons under data/dj-icons/ (Docker-
// persisted). Keeps the newest few for quick reuse. null in settings means
// the seeded starter default (dj-icon-headphones.png / public/dj-icons/headphones.png).
//
// Bundled starters in public/dj-icons/ are generic (safe to share). Event-
// specific art such as DJ Holy Roller lives only under data/dj-icons/ locally.

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

// Gallery cap: all bundled starters stay, plus a few host uploads.
export const MAX_DJ_ICONS = 30;

// Stable gallery names for bundled styles (copied from public/dj-icons).
const STARTER_ICONS = [
  { src: "headphones.png", dest: "dj-icon-headphones.png" },
  { src: "cartoon.png", dest: "dj-icon-cartoon.png" },
  { src: "retro.png", dest: "dj-icon-retro.png" },
  { src: "neon.png", dest: "dj-icon-neon.png" },
  { src: "boombox.png", dest: "dj-icon-boombox.png" },
  { src: "cassette.png", dest: "dj-icon-cassette.png" },
  { src: "disco.png", dest: "dj-icon-disco.png" },
  { src: "mixer.png", dest: "dj-icon-mixer.png" },
  { src: "turntable.png", dest: "dj-icon-turntable.png" },
  { src: "vinyl.png", dest: "dj-icon-vinyl.png" },
  { src: "mic.png", dest: "dj-icon-mic.png" },
  { src: "speaker.png", dest: "dj-icon-speaker.png" },
  { src: "waveform.png", dest: "dj-icon-waveform.png" },
  { src: "equalizer.png", dest: "dj-icon-equalizer.png" },
  { src: "laser.png", dest: "dj-icon-laser.png" },
  { src: "deck.png", dest: "dj-icon-deck.png" },
  { src: "controller.png", dest: "dj-icon-controller.png" },
  { src: "radio.png", dest: "dj-icon-radio.png" },
  { src: "amp.png", dest: "dj-icon-amp.png" },
  { src: "party.png", dest: "dj-icon-party.png" },
  { src: "notes.png", dest: "dj-icon-notes.png" },
  { src: "spotlight.png", dest: "dj-icon-spotlight.png" },
];
const STARTER_DEST = new Set(STARTER_ICONS.map((s) => s.dest));
const STARTER_ORDER = new Map(
  STARTER_ICONS.map((s, i) => [s.dest, i])
);
// Event-specific locals: keep in data/, show last in the gallery.
const LOCAL_TRAILER_ICONS = [
  "dj-icon-holyroller.png",
  "dj-icon-flat.png",
];
const LOCAL_TRAILER_SET = new Set(LOCAL_TRAILER_ICONS);
const LOCAL_TRAILER_ORDER = new Map(
  LOCAL_TRAILER_ICONS.map((name, i) => [name, i])
);
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
// Preferred: dj-icon-headphones.png. Still accept older dj-icon-1-flat.png forms.
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

/** Host uploads use an 8-char base36 id: dj-icon-1d0ti9t4.png */
function isRandomUploadName(name) {
  const m = /^dj-icon-([a-z0-9]+)\.(png|jpg|webp|gif)$/i.exec(String(name || ""));
  if (!m) return false;
  return m[1].length === 8 && !STARTER_DEST.has(name);
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

// Icon files: starters, then local named art (e.g. Holy Roller), then uploads.
export function listDjIcons() {
  try {
    seedStarterDjIcons();
    ensureDir();
    return fs
      .readdirSync(ICONS_DIR)
      .filter(isSafeDjIconName)
      .map((name) => {
        const st = fs.statSync(path.join(ICONS_DIR, name));
        return { name, mtime: st.mtimeMs, size: st.size };
      })
      // Drop corrupt/empty upload stubs so they don't clutter the gallery.
      .filter((e) => e.size > 1024)
      .sort((a, b) => {
        // Shared starters (pack order) → other named → uploads → Holy Roller locals.
        const rank = (name) => {
          if (LOCAL_TRAILER_SET.has(name)) return 3;
          if (isStarterDjIconName(name)) return 0;
          if (isRandomUploadName(name)) return 2;
          return 1;
        };
        const d = rank(a.name) - rank(b.name);
        if (d !== 0) return d;
        if (rank(a.name) === 0) {
          return (
            (STARTER_ORDER.get(a.name) ?? 999) -
            (STARTER_ORDER.get(b.name) ?? 999)
          );
        }
        if (rank(a.name) === 3) {
          return (
            (LOCAL_TRAILER_ORDER.get(a.name) ?? 999) -
            (LOCAL_TRAILER_ORDER.get(b.name) ?? 999)
          );
        }
        return b.mtime - a.mtime;
      })
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

// Only prune random uploads past MAX_DJ_ICONS. Named locals (Holy Roller,
// flat, etc.) and bundled starters are never auto-deleted.
function prune(keepName) {
  const all = listDjIcons().map((b) => b.name);
  const uploads = all.filter(isRandomUploadName);
  const keepUploads = new Set(uploads.slice(0, Math.max(0, MAX_DJ_ICONS)));
  if (keepName && isRandomUploadName(keepName) && djIconExists(keepName)) {
    keepUploads.add(keepName);
  }
  for (const name of uploads) {
    if (keepUploads.has(name)) continue;
    try {
      fs.unlinkSync(path.join(ICONS_DIR, name));
    } catch (err) {
      console.error("[dj-icon] prune failed:", err.message);
    }
  }
  // Also sweep tiny corrupt stubs that listDjIcons hides.
  try {
    for (const name of fs.readdirSync(ICONS_DIR)) {
      if (!isRandomUploadName(name)) continue;
      const p = path.join(ICONS_DIR, name);
      if (fs.statSync(p).size > 1024) continue;
      try {
        fs.unlinkSync(p);
      } catch (err) {
        console.error("[dj-icon] stub prune failed:", err.message);
      }
    }
  } catch (err) {
    console.error("[dj-icon] stub scan failed:", err.message);
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
