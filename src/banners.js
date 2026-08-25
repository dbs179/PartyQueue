// Hero-banner store: keeps host-uploaded banners on disk (under data/, so they
// survive restarts and ride the Docker volume) and retains only the most recent
// few for quick reuse. Images arrive as data URLs from the Settings page; we
// validate the type/size, write a fresh file, and prune older ones.
// Bundled starters live in public/banners/ and are seeded into data/ when missing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import { imageMatchesMime } from "./image-signature.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANNERS_DIR = path.join(__dirname, "..", "data", "banners");
const STARTER_DIR = path.join(__dirname, "..", "public", "banners");
// Host-deleted bundled starters stay gone across list/seed/restart.
const REMOVED_STARTERS_FILE = path.join(BANNERS_DIR, ".removed-starters.json");

export const MAX_BANNERS = 20;
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB decoded image cap

// Desktop banners are long thin strips (~7:1 like Swinefeld). Phone banners are
// taller stacked headers (~16:9). Galleries filter by these ratios.
export const DESKTOP_BANNER_MIN_RATIO = 3.5;
export const PHONE_BANNER_MIN_RATIO = 1.2;
export const PHONE_BANNER_MAX_RATIO = 2.5;

// Bundled defaults shipped on GitHub (public/banners → data/banners).
// Naming: pc-banner-* = desktop strip, md-banner-* = phone (type-first so
// listings group by slot). hero.jpg remains the true app Default (null).
const STARTER_BANNERS = [
  { src: "pc-banner-vinyl.jpg", dest: "pc-banner-vinyl.jpg" },
  { src: "pc-banner-speakers.jpg", dest: "pc-banner-speakers.jpg" },
  { src: "pc-banner-backyard.jpg", dest: "pc-banner-backyard.jpg" },
  { src: "pc-banner-karaoke.jpg", dest: "pc-banner-karaoke.jpg" },
  { src: "pc-banner-records.jpg", dest: "pc-banner-records.jpg" },
  { src: "pc-banner-swinefeld.png", dest: "pc-banner-swinefeld.png" },
  { src: "md-banner-vinyl.jpg", dest: "md-banner-vinyl.jpg" },
  { src: "md-banner-speakers.jpg", dest: "md-banner-speakers.jpg" },
  { src: "md-banner-backyard.jpg", dest: "md-banner-backyard.jpg" },
  { src: "md-banner-karaoke.jpg", dest: "md-banner-karaoke.jpg" },
  { src: "md-banner-records.jpg", dest: "md-banner-records.jpg" },
  { src: "md-banner-swinefeld.jpg", dest: "md-banner-swinefeld.jpg" },
];
const STARTER_DEST = new Set(STARTER_BANNERS.map((s) => s.dest));

// Shared gallery order for pc-banner-* / md-banner-* pairs so Desktop and
// Phone galleries line up. Host uploads (banner-<id>.*) sort after these.
const BANNER_THEME_ORDER = [
  "vinyl",
  "speakers",
  "backyard",
  "karaoke",
  "records",
  "swinefeld",
];

/**
 * Theme slug for pairing desktop/phone variants, or null for uploads/other.
 * @param {string} name
 * @returns {string|null}
 */
export function bannerThemeSlug(name) {
  const n = String(name || "");
  let m = /^(?:pc-|md-)banner-([a-z0-9]+(?:-[a-z0-9]+)*)\./i.exec(n);
  if (m) return m[1].toLowerCase();
  m = /^banner-(?:pc|md)-([a-z0-9]+(?:-[a-z0-9]+)*)\./i.exec(n);
  if (m) return m[1].toLowerCase();
  m = /^banner-([a-z0-9]+(?:-[a-z0-9]+)*)-phone\./i.exec(n);
  if (m) return m[1].toLowerCase();
  return null;
}

/**
 * Stable gallery sort: known themes (same order on PC and phone), then
 * other named themes alphabetically, then uploads last (by name).
 * @param {{ name: string }} a
 * @param {{ name: string }} b
 */
export function compareBannerGalleryOrder(a, b) {
  const na = String(a?.name || "");
  const nb = String(b?.name || "");
  const ta = bannerThemeSlug(na);
  const tb = bannerThemeSlug(nb);
  const rank = (theme, name) => {
    if (theme) {
      const i = BANNER_THEME_ORDER.indexOf(theme);
      if (i >= 0) return [0, i, theme];
      return [1, 0, theme];
    }
    return [2, 0, name.toLowerCase()];
  };
  const ra = rank(ta, na);
  const rb = rank(tb, nb);
  for (let i = 0; i < ra.length; i += 1) {
    if (ra[i] < rb[i]) return -1;
    if (ra[i] > rb[i]) return 1;
  }
  return na.localeCompare(nb);
}

// Older banner-1-starterNN.* names → current type-first filenames (no ext).
const LEGACY_STARTER_SLUGS = {
  "01": "pc-banner-vinyl",
  "02": "pc-banner-speakers",
  "03": "pc-banner-backyard",
  "04": "pc-banner-karaoke",
  "05": "pc-banner-records",
  "06": "banner-kitchen",
  "07": "banner-acoustic",
  "08": "banner-dancefloor",
  "09": "banner-jukebox",
  "10": "banner-rooftop",
};

// Older names → current pc-banner-* / md-banner-* (settings follow via rename map).
const LEGACY_BANNER_RENAMES = {
  "banner-vinyl.jpg": "pc-banner-vinyl.jpg",
  "banner-speakers.jpg": "pc-banner-speakers.jpg",
  "banner-backyard.jpg": "pc-banner-backyard.jpg",
  "banner-karaoke.jpg": "pc-banner-karaoke.jpg",
  "banner-records.jpg": "pc-banner-records.jpg",
  "banner-swinefeld.png": "pc-banner-swinefeld.png",
  "banner-pc-vinyl.jpg": "pc-banner-vinyl.jpg",
  "banner-pc-speakers.jpg": "pc-banner-speakers.jpg",
  "banner-pc-backyard.jpg": "pc-banner-backyard.jpg",
  "banner-pc-karaoke.jpg": "pc-banner-karaoke.jpg",
  "banner-pc-records.jpg": "pc-banner-records.jpg",
  "banner-pc-swinefeld.png": "pc-banner-swinefeld.png",
  "banner-vinyl-phone.jpg": "md-banner-vinyl.jpg",
  "banner-speakers-phone.jpg": "md-banner-speakers.jpg",
  "banner-backyard-phone.jpg": "md-banner-backyard.jpg",
  "banner-karaoke-phone.jpg": "md-banner-karaoke.jpg",
  "banner-records-phone.jpg": "md-banner-records.jpg",
  "banner-swinefeld-phone.jpg": "md-banner-swinefeld.jpg",
  "banner-md-vinyl.jpg": "md-banner-vinyl.jpg",
  "banner-md-speakers.jpg": "md-banner-speakers.jpg",
  "banner-md-backyard.jpg": "md-banner-backyard.jpg",
  "banner-md-karaoke.jpg": "md-banner-karaoke.jpg",
  "banner-md-records.jpg": "md-banner-records.jpg",
  "banner-md-swinefeld.jpg": "md-banner-swinefeld.jpg",
};

const BANNER_EXT = "png|jpg|webp|gif";
// Preferred: pc-banner-vinyl.jpg / md-banner-vinyl.jpg. Still accept uploads
// as banner-<id>.ext and older banner-pc-* / banner-*-phone forms.
const BANNER_NAME_RE = new RegExp(
  `^(?:pc-|md-)?banner-(?:\\d+-)?[a-z0-9]+(?:-[a-z0-9]+)*\\.(${BANNER_EXT})$`,
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

function loadRemovedStarters() {
  try {
    const raw = JSON.parse(fs.readFileSync(REMOVED_STARTERS_FILE, "utf8"));
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((name) => isStarterBannerName(name)));
  } catch {
    return new Set();
  }
}

function rememberRemovedStarter(name) {
  if (!isStarterBannerName(name)) return;
  const next = loadRemovedStarters();
  if (next.has(name)) return;
  next.add(name);
  writeFileAtomic(
    REMOVED_STARTERS_FILE,
    `${JSON.stringify([...next].sort(), null, 2)}\n`
  );
}

function unlinkBannerFile(name) {
  fs.unlinkSync(path.join(BANNERS_DIR, name));
  rememberRemovedStarter(name);
}

/**
 * Read width/height from PNG/JPEG/GIF/WEBP headers (no decode).
 * @param {Buffer} buf
 * @returns {{ width: number, height: number }|null}
 */
export function readImageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  // PNG
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WEBP (VP8 / VP8L / VP8X)
  if (
    buf.length >= 30 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buf.length >= 30) {
      const width = 1 + buf.readUIntLE(24, 3);
      const height = 1 + buf.readUIntLE(27, 3);
      return { width, height };
    }
    if (chunk === "VP8L" && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    if (chunk === "VP8 " && buf.length >= 30 && buf[23] === 0x9d) {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      };
    }
  }
  // JPEG — scan for SOF0/SOF2
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 8 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        i += 2;
        continue;
      }
      const size = buf.readUInt16BE(i + 2);
      if (size < 2 || i + 2 + size > buf.length) break;
      // Baseline / progressive DCT
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return {
          height: buf.readUInt16BE(i + 5),
          width: buf.readUInt16BE(i + 7),
        };
      }
      i += 2 + size;
    }
  }
  return null;
}

/**
 * @param {number} width
 * @param {number} height
 * @returns {"desktop"|"mobile"|"either"|"none"}
 */
export function bannerSlotForAspect(width, height) {
  if (!(width > 0) || !(height > 0)) return "none";
  const ratio = width / height;
  const desktop = ratio >= DESKTOP_BANNER_MIN_RATIO;
  const mobile =
    ratio >= PHONE_BANNER_MIN_RATIO && ratio <= PHONE_BANNER_MAX_RATIO;
  if (desktop && mobile) return "either";
  if (desktop) return "desktop";
  if (mobile) return "mobile";
  return "none";
}

/**
 * @param {"desktop"|"mobile"} slot
 * @param {"desktop"|"mobile"|"either"|"none"} fit
 */
export function bannerFitsSlot(slot, fit) {
  if (fit === "either") return true;
  if (fit === "none") return false;
  return fit === slot;
}

function probeBannerFile(name) {
  try {
    const buf = fs.readFileSync(path.join(BANNERS_DIR, name));
    const size = readImageSize(buf);
    if (!size) return { width: 0, height: 0, ratio: 0, fit: "none" };
    const ratio = size.width / size.height;
    return {
      width: size.width,
      height: size.height,
      ratio,
      fit: bannerSlotForAspect(size.width, size.height),
    };
  } catch {
    return { width: 0, height: 0, ratio: 0, fit: "none" };
  }
}

/** Rename legacy starter / phone / banner-pc-* names → pc-banner-* / md-banner-*. */
export function migrateBannerFilenames() {
  const renamed = new Map();
  try {
    if (!fs.existsSync(BANNERS_DIR)) return renamed;
    ensureDir();
    for (const name of fs.readdirSync(BANNERS_DIR)) {
      let dest = LEGACY_BANNER_RENAMES[name] || null;
      if (!dest) {
        const starter = /^banner-1-starter(\d+)\.(png|jpg|webp|gif)$/i.exec(name);
        if (starter) {
          const slug =
            LEGACY_STARTER_SLUGS[starter[1].padStart(2, "0")] ||
            LEGACY_STARTER_SLUGS[starter[1]];
          if (slug) dest = `${slug}.${starter[2].toLowerCase()}`;
        } else {
          const phone = /^banner-([a-z0-9]+)-phone\.(png|jpg|webp|gif)$/i.exec(
            name
          );
          if (phone) {
            dest = `md-banner-${phone[1].toLowerCase()}.${phone[2].toLowerCase()}`;
          } else {
            const slotPrefixed =
              /^banner-(pc|md)-([a-z0-9]+(?:-[a-z0-9]+)*)\.(png|jpg|webp|gif)$/i.exec(
                name
              );
            if (slotPrefixed) {
              dest = `${slotPrefixed[1].toLowerCase()}-banner-${slotPrefixed[2].toLowerCase()}.${slotPrefixed[3].toLowerCase()}`;
            } else {
              const m = /^banner-(\d+)-([a-z0-9]+)\.(png|jpg|webp|gif)$/i.exec(
                name
              );
              if (m) {
                dest = `banner-${m[2].toLowerCase()}.${m[3].toLowerCase()}`;
              }
            }
          }
        }
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

/**
 * Copy any missing bundled starter banners into data/. Never overwrites.
 * Matches DJ-icon seeding so Unraid upgrades that already have desktop files
 * still pick up new phone (md-banner-*) starters from the image.
 */
export function seedStarterBanners() {
  try {
    if (!fs.existsSync(STARTER_DIR)) return 0;
    ensureDir();
    const removed = loadRemovedStarters();
    let copied = 0;
    for (const { src, dest } of STARTER_BANNERS) {
      if (removed.has(dest)) continue;
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

/**
 * Banner files in stable gallery order (matched themes across PC/phone,
 * uploads last).
 * @returns {Array<{
 *   name: string,
 *   url: string,
 *   starter: boolean,
 *   width: number,
 *   height: number,
 *   ratio: number,
 *   fit: "desktop"|"mobile"|"either"|"none",
 * }>}
 */
export function listBanners() {
  try {
    migrateBannerFilenames();
    seedStarterBanners();
    ensureDir();
    return fs
      .readdirSync(BANNERS_DIR)
      .filter(isSafeName)
      .map((name) => {
        const probe = probeBannerFile(name);
        return {
          name,
          url: `/banners/${name}`,
          starter: isStarterBannerName(name),
          width: probe.width,
          height: probe.height,
          ratio: probe.ratio,
          fit: probe.fit,
        };
      })
      .sort(compareBannerGalleryOrder);
  } catch (err) {
    console.error("[banners] list failed:", err.message);
    return [];
  }
}

/**
 * @param {"desktop"|"mobile"} [slot]
 */
export function listBannersForSlot(slot = "desktop") {
  const want = slot === "mobile" ? "mobile" : "desktop";
  return listBanners().filter((b) => bannerFitsSlot(want, b.fit));
}

export function bannerExists(name) {
  return isSafeName(name) && fs.existsSync(path.join(BANNERS_DIR, name));
}

export function bannerPath(name) {
  return isSafeName(name) ? path.join(BANNERS_DIR, name) : null;
}

// Delete everything except the newest MAX_BANNERS, always protecting `keepName`
// (the active banner). Starters are deletable and no longer immortal in prune.
function prune(keepName) {
  const all = listBanners().map((b) => b.name);
  const keep = new Set(all.slice(0, MAX_BANNERS));
  if (keepName && bannerExists(keepName)) keep.add(keepName);
  for (const name of all) {
    if (!keep.has(name)) {
      try {
        unlinkBannerFile(name);
      } catch (err) {
        console.error("[banners] prune failed:", err.message);
      }
    }
  }
}

// Decode + persist a data-URL image, returning the stored filename. Throws on
// an unsupported type or oversized payload.
export function saveBanner(dataUrl) {
  const m = /^data:([a-z0-9/+.-]+);base64,(.+)$/is.exec(
    String(dataUrl || "").trim()
  );
  if (!m) throw new Error("Expected a base64 image data URL.");
  const ext = EXT_BY_MIME[m[1].toLowerCase()];
  if (!ext) throw new Error("Unsupported image type. Use PNG, JPG, WEBP or GIF.");

  const buf = Buffer.from(m[2], "base64");
  if (!buf.length) throw new Error("Image data was empty.");
  if (buf.length > MAX_BYTES) throw new Error("Image is too large (8 MB max).");
  if (!imageMatchesMime(buf, m[1].toLowerCase())) {
    throw new Error("Image data does not match its declared type.");
  }

  ensureDir();
  const name = `banner-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  fs.writeFileSync(path.join(BANNERS_DIR, name), buf);
  prune(name);
  return name;
}

// Remove one banner; returns true if it existed. Any stored banner is deletable
// (Default / hero.jpg is not a stored banner).
export function deleteBanner(name) {
  if (!bannerExists(name)) return false;
  try {
    unlinkBannerFile(name);
    return true;
  } catch (err) {
    console.error("[banners] delete failed:", err.message);
    return false;
  }
}
