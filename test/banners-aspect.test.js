import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readImageSize,
  bannerSlotForAspect,
  bannerFitsSlot,
  isSafeBannerName,
  bannerThemeSlug,
  compareBannerGalleryOrder,
  DESKTOP_BANNER_MIN_RATIO,
  PHONE_BANNER_MAX_RATIO,
} from "../src/banners.js";

test("isSafeBannerName accepts pc-banner-/md-banner- prefixes", () => {
  assert.equal(isSafeBannerName("pc-banner-vinyl.jpg"), true);
  assert.equal(isSafeBannerName("md-banner-vinyl.jpg"), true);
  assert.equal(isSafeBannerName("pc-banner-swinefeld.png"), true);
  assert.equal(isSafeBannerName("banner-0abc12.png"), true);
  assert.equal(isSafeBannerName("../evil.png"), false);
});

test("compareBannerGalleryOrder keeps themes aligned and uploads last", () => {
  assert.equal(bannerThemeSlug("pc-banner-vinyl.jpg"), "vinyl");
  assert.equal(bannerThemeSlug("md-banner-vinyl.jpg"), "vinyl");
  assert.equal(bannerThemeSlug("banner-0f6svnv0.png"), null);

  const names = [
    "banner-0f6svnv0.png",
    "md-banner-speakers.jpg",
    "md-banner-vinyl.jpg",
    "md-banner-swinefeld.jpg",
    "pc-banner-karaoke.jpg",
    "pc-banner-vinyl.jpg",
  ];
  const ordered = [...names]
    .map((name) => ({ name }))
    .sort(compareBannerGalleryOrder)
    .map((b) => b.name);
  assert.deepEqual(ordered, [
    "md-banner-vinyl.jpg",
    "pc-banner-vinyl.jpg",
    "md-banner-speakers.jpg",
    "pc-banner-karaoke.jpg",
    "md-banner-swinefeld.jpg",
    "banner-0f6svnv0.png",
  ]);
});

test("bannerSlotForAspect classifies wide vs phone ratios", () => {
  assert.equal(bannerSlotForAspect(4000, 560), "desktop");
  assert.equal(bannerSlotForAspect(1600, 900), "mobile");
  assert.equal(bannerSlotForAspect(100, 100), "none");
  assert.ok(4000 / 560 >= DESKTOP_BANNER_MIN_RATIO);
  assert.ok(1600 / 900 <= PHONE_BANNER_MAX_RATIO);
  assert.equal(bannerFitsSlot("desktop", "desktop"), true);
  assert.equal(bannerFitsSlot("desktop", "mobile"), false);
  assert.equal(bannerFitsSlot("mobile", "either"), true);
});

test("readImageSize reads JPEG and PNG headers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pq-banner-size-"));
  try {
    // Minimal 1x1 PNG
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
      "hex"
    );
    const pngPath = path.join(dir, "one.png");
    fs.writeFileSync(pngPath, png);
    assert.deepEqual(readImageSize(fs.readFileSync(pngPath)), {
      width: 1,
      height: 1,
    });

    const vinylFs = path.resolve("data/banners/pc-banner-vinyl.jpg");
    if (fs.existsSync(vinylFs)) {
      const size = readImageSize(fs.readFileSync(vinylFs));
      assert.ok(size);
      assert.equal(size.width, 4000);
      assert.equal(size.height, 560);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
