import { test } from "node:test";
import assert from "node:assert/strict";
import {
  paintRotationPool,
  readRotationPoolIds,
  setRotationPoolButtonOn,
  wireRotationPool,
} from "../public/js/rotation-pool.js";

function chip(id, attr = "data-pool-preset") {
  const classes = new Set();
  const attrs = { [attr]: id };
  return {
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
        return !!on;
      },
      contains(name) {
        return classes.has(name);
      },
    },
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name)
        ? attrs[name]
        : null;
    },
    closest(sel) {
      if (sel === `[${attr}]`) return this;
      return null;
    },
    _classes: classes,
  };
}

function pool(attr, ids) {
  const buttons = ids.map((id) => chip(id, attr));
  const listeners = {};
  return {
    buttons,
    querySelectorAll(sel) {
      const wantOn = sel.endsWith(".on");
      const base = `[${attr}]`;
      if (!sel.startsWith(base)) return [];
      return buttons.filter((b) => {
        if (wantOn && !b.classList.contains("on")) return false;
        return b.getAttribute(attr) != null;
      });
    },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    click(target) {
      for (const fn of listeners.click || []) fn({ target });
    },
  };
}

test("paintRotationPool toggles on/aria-pressed from ids", () => {
  const container = pool("data-pool-preset", ["party", "chill", "focus"]);
  paintRotationPool(container, "data-pool-preset", ["party", "focus"]);
  assert.equal(container.buttons[0].classList.contains("on"), true);
  assert.equal(container.buttons[0].getAttribute("aria-pressed"), "true");
  assert.equal(container.buttons[1].classList.contains("on"), false);
  assert.equal(container.buttons[1].getAttribute("aria-pressed"), "false");
  assert.equal(container.buttons[2].classList.contains("on"), true);
});

test("readRotationPoolIds returns selected chip values", () => {
  const container = pool("data-pool-decade", ["80s", "90s", "2000s"]);
  setRotationPoolButtonOn(container.buttons[0], true);
  setRotationPoolButtonOn(container.buttons[2], true);
  assert.deepEqual(readRotationPoolIds(container, "data-pool-decade"), [
    "80s",
    "2000s",
  ]);
});

test("wireRotationPool toggles chip and reports ids", () => {
  const container = pool("data-pool-preset", ["party", "chill"]);
  paintRotationPool(container, "data-pool-preset", ["party"]);
  const seen = [];
  wireRotationPool(container, "data-pool-preset", (ids) => seen.push(ids));
  container.click(container.buttons[1]);
  assert.deepEqual(seen[0], ["party", "chill"]);
  container.click(container.buttons[0]);
  assert.deepEqual(seen[1], ["chill"]);
});

test("paintRotationPool no-ops on missing container", () => {
  assert.equal(paintRotationPool(null, "data-pool-preset", ["party"]), undefined);
  assert.deepEqual(readRotationPoolIds(null, "data-pool-preset"), []);
});
