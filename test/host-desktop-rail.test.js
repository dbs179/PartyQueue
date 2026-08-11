import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHostDesktopRail,
  HOST_DESKTOP_RAIL_BODY_CLASS,
} from "../public/js/host-desktop-rail.js";

function makeNode(id) {
  const kids = [];
  const node = {
    id,
    hidden: false,
    parentElement: null,
    classList: {
      _set: new Set(),
      toggle(name, on) {
        if (on) this._set.add(name);
        else this._set.delete(name);
        return on;
      },
      contains(name) {
        return this._set.has(name);
      },
    },
    appendChild(child) {
      if (child.parentElement) {
        const i = child.parentElement._kids.indexOf(child);
        if (i >= 0) child.parentElement._kids.splice(i, 1);
      }
      child.parentElement = node;
      kids.push(child);
      return child;
    },
    _kids: kids,
  };
  return node;
}

function makeMql(matches) {
  const listeners = [];
  return {
    matches,
    addEventListener(_type, fn) {
      listeners.push(fn);
    },
    removeEventListener(_type, fn) {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    _set(next) {
      this.matches = next;
      for (const fn of listeners) fn();
    },
  };
}

test("createHostDesktopRail parks transport in rail when host open + wide", () => {
  const home = makeNode("home");
  const rail = makeNode("rail");
  const protectedEl = makeNode("protected");
  home.appendChild(protectedEl);
  const body = makeNode("body");
  const mql = makeMql(true);

  const api = createHostDesktopRail({
    rail,
    home,
    protectedEl,
    matchMedia: () => mql,
    root: body,
  });

  assert.equal(api.isActive(), false);
  assert.equal(rail.hidden, true);

  api.setHostOpen(true);
  assert.equal(api.isActive(), true);
  assert.equal(protectedEl.parentElement, rail);
  assert.equal(rail.hidden, false);
  assert.equal(body.classList.contains(HOST_DESKTOP_RAIL_BODY_CLASS), true);

  api.setHostOpen(false);
  assert.equal(api.isActive(), false);
  assert.equal(protectedEl.parentElement, home);
  assert.equal(rail.hidden, true);
  assert.equal(body.classList.contains(HOST_DESKTOP_RAIL_BODY_CLASS), false);
});

test("createHostDesktopRail stays home when viewport is narrow", () => {
  const home = makeNode("home");
  const rail = makeNode("rail");
  const protectedEl = makeNode("protected");
  home.appendChild(protectedEl);
  const body = makeNode("body");
  const mql = makeMql(false);

  const api = createHostDesktopRail({
    rail,
    home,
    protectedEl,
    matchMedia: () => mql,
    root: body,
  });

  api.setHostOpen(true);
  assert.equal(api.isActive(), false);
  assert.equal(protectedEl.parentElement, home);

  mql._set(true);
  assert.equal(api.isActive(), true);
  assert.equal(protectedEl.parentElement, rail);
});

test("createHostDesktopRail ignores hidden protected controls", () => {
  const home = makeNode("home");
  const rail = makeNode("rail");
  const protectedEl = makeNode("protected");
  protectedEl.hidden = true;
  home.appendChild(protectedEl);
  const body = makeNode("body");
  const mql = makeMql(true);

  const api = createHostDesktopRail({
    rail,
    home,
    getProtectedEl: () => protectedEl,
    matchMedia: () => mql,
    root: body,
  });

  api.setHostOpen(true);
  assert.equal(api.isActive(), false);
  assert.equal(protectedEl.parentElement, home);

  protectedEl.hidden = false;
  api.sync();
  assert.equal(api.isActive(), true);
  assert.equal(protectedEl.parentElement, rail);
});
