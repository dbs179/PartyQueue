import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryTrackRowHtml, renderMemory } from "../public/js/memory-ui.js";

test("memoryTrackRowHtml includes title and index", () => {
  const html = memoryTrackRowHtml(
    { title: "Song", artist: "Artist", image: "http://x/a.jpg" },
    2
  );
  assert.match(html, /queue-index">3</);
  assert.match(html, /Song/);
  assert.match(html, /Artist/);
  assert.match(html, /http:\/\/x\/a\.jpg/);
});

test("renderMemory fills list and toggles empty state", () => {
  const kids = [];
  const listEl = {
    innerHTML: "x",
    appendChild(n) {
      kids.push(n);
    },
  };
  const emptyEl = { hidden: false, textContent: "" };
  const introEl = { hidden: true };
  const countEl = { textContent: "" };
  globalThis.document = {
    createElement(tag) {
      return { tagName: tag, className: "", innerHTML: "" };
    },
  };

  try {
    renderMemory(
      { listEl, emptyEl, introEl, countEl },
      [{ title: "One", artist: "A" }],
      3000
    );
    assert.equal(listEl.innerHTML, "");
    assert.equal(kids.length, 1);
    assert.equal(kids[0].className, "track");
    assert.equal(emptyEl.hidden, true);
    assert.equal(introEl.hidden, false);
    assert.equal(countEl.textContent, "(1 / 3000)");
  } finally {
    delete globalThis.document;
  }
});
