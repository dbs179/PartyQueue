import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { showToast, resetToastForTests } from "../public/js/toast.js";

function makeToastEl() {
  const classes = new Set();
  return {
    textContent: "",
    children: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, on) => {
        if (on) classes.add(c);
        else classes.delete(c);
      },
      contains: (c) => classes.has(c),
    },
    replaceChildren(...nodes) {
      this.children = nodes;
      if (!nodes.length) this.textContent = "";
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
  };
}

beforeEach(() => {
  resetToastForTests();
  mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(() => {
  mock.timers.reset();
  resetToastForTests();
  delete globalThis.document;
});

test("showToast is a no-op without #toast", () => {
  globalThis.document = { getElementById: () => null };
  assert.doesNotThrow(() => showToast("hi"));
});

test("showToast paints a plain message and auto-hides", () => {
  const el = makeToastEl();
  globalThis.document = {
    getElementById: (id) => (id === "toast" ? el : null),
    createElement: () => ({}),
  };
  showToast("Added 5 songs", false, 2000);
  assert.equal(el.textContent, "Added 5 songs");
  assert.equal(el.classList.contains("show"), true);
  assert.equal(el.classList.contains("error"), false);
  mock.timers.tick(2000);
  assert.equal(el.classList.contains("show"), false);
});

test("showToast marks errors", () => {
  const el = makeToastEl();
  globalThis.document = {
    getElementById: (id) => (id === "toast" ? el : null),
    createElement: () => ({}),
  };
  showToast("Nope", true);
  assert.equal(el.classList.contains("error"), true);
});
