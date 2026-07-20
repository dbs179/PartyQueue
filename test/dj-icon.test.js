import { test, after } from "node:test";
import assert from "node:assert/strict";

import { saveDjIcon, deleteDjIcon } from "../src/dj-icon.js";

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const created = [];

after(() => {
  for (const name of created) {
    try {
      deleteDjIcon(name);
    } catch {
      /* ignore */
    }
  }
});

test("saveDjIcon rejects SVG uploads", () => {
  const svg =
    "data:image/svg+xml;base64," +
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString(
      "base64"
    );
  assert.throws(() => saveDjIcon(svg), /SVG uploads are not allowed/i);
});

test("saveDjIcon accepts a small PNG", () => {
  const name = saveDjIcon(TINY_PNG);
  created.push(name);
  assert.match(name, /^dj-icon-[a-z0-9]+\.png$/i);
});
