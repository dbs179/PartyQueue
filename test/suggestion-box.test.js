import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_FILE = path.join(
  os.tmpdir(),
  `pq-suggestions-${process.pid}-${Date.now()}.json`
);
process.env.PARTYQUEUE_SUGGESTIONS_FILE = TMP_FILE;

const box = await import("../src/suggestion-box.js");

beforeEach(() => {
  box.clearSuggestions();
});

test("rejects blank or tiny text", () => {
  assert.equal(box.addSuggestion({ text: "  ", requestedBy: "Sam" }), null);
  assert.equal(box.addSuggestion({ text: "ab", requestedBy: "Sam" }), null);
  assert.equal(box.getSuggestions().length, 0);
});

test("records suggestion with sanitized name", () => {
  const row = box.addSuggestion(
    { text: "  More country please!  ", requestedBy: "  Sam  " },
    1000
  );
  assert.ok(row.id);
  assert.equal(row.text, "More country please!");
  assert.equal(row.requestedBy, "Sam");
  assert.equal(row.done, false);
  assert.equal(row.ts, 1000);
});

test("caps text length", () => {
  const long = "x".repeat(500);
  const row = box.addSuggestion({ text: long, requestedBy: "Pat" });
  assert.equal(row.text.length, box.SUGGESTION_TEXT_MAX);
});

test("setSuggestionDone toggles and sorts open before done", () => {
  const a = box.addSuggestion({ text: "Idea A", requestedBy: "A" }, 100);
  const b = box.addSuggestion({ text: "Idea B", requestedBy: "B" }, 200);
  box.setSuggestionDone(a.id, true, 300);
  const list = box.getSuggestions();
  assert.equal(list[0].id, b.id);
  assert.equal(list[0].done, false);
  assert.equal(list[1].id, a.id);
  assert.equal(list[1].done, true);
  assert.equal(list[1].doneAt, 300);
  const counts = box.suggestionCounts();
  assert.deepEqual(counts, { open: 1, done: 1, total: 2 });
});

test("persists to disk", () => {
  const row = box.addSuggestion({ text: "Keep this", requestedBy: "Dave" }, 42);
  const raw = JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
  assert.ok(raw.some((e) => e.id === row.id && e.text === "Keep this"));
});

test("clearSuggestions empties the store", () => {
  box.addSuggestion({ text: "Gone soon", requestedBy: "X" });
  box.clearSuggestions();
  assert.equal(box.getSuggestions().length, 0);
  assert.equal(fs.existsSync(TMP_FILE), false);
});
