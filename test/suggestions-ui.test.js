import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUGGESTION_TEXT_MAX,
  formatSuggestionCharCount,
  filterSuggestions,
  suggestionsCountLabel,
  suggestionsEmptyMessage,
  suggestionRowHtml,
  wireSuggestionCharCount,
} from "../public/js/suggestions.js";

test("formatSuggestionCharCount formats length against max", () => {
  assert.equal(formatSuggestionCharCount(12), `12 / ${SUGGESTION_TEXT_MAX}`);
  assert.equal(formatSuggestionCharCount(-1, 10), "0 / 10");
});

test("filterSuggestions splits open / done / all", () => {
  const all = [
    { id: "1", done: false },
    { id: "2", done: true },
    { id: "3", done: false },
  ];
  assert.deepEqual(
    filterSuggestions(all, "open").map((s) => s.id),
    ["1", "3"]
  );
  assert.deepEqual(
    filterSuggestions(all, "done").map((s) => s.id),
    ["2"]
  );
  assert.equal(filterSuggestions(all, "all").length, 3);
});

test("suggestionsCountLabel and empty messages", () => {
  assert.equal(suggestionsCountLabel([]), "");
  assert.equal(
    suggestionsCountLabel([{ done: false }, { done: true }]),
    "(1 open · 2)"
  );
  assert.match(suggestionsEmptyMessage("open"), /inbox zero/);
  assert.match(suggestionsEmptyMessage("done"), /implemented/);
  assert.match(suggestionsEmptyMessage("all"), /No suggestions/);
});

test("suggestionRowHtml escapes text and marks done", () => {
  const html = suggestionRowHtml(
    {
      text: `<img src=x>`,
      requestedBy: "Dave",
      ts: Date.now(),
      done: true,
    },
    Date.now()
  );
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /&lt;img/);
  assert.match(html, /checked/);
  assert.match(html, /Dave/);
});

test("wireSuggestionCharCount syncs on input and returns sync fn", () => {
  const listeners = {};
  const textEl = {
    value: "hi",
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
  };
  const countEl = { textContent: "" };
  const sync = wireSuggestionCharCount(textEl, countEl, 50);
  assert.equal(countEl.textContent, "2 / 50");
  textEl.value = "hello";
  listeners.input();
  assert.equal(countEl.textContent, "5 / 50");
  textEl.value = "";
  sync();
  assert.equal(countEl.textContent, "0 / 50");
});
