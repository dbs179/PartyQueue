import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeDisplayName,
  sanitizeDedication,
  resolveGuestIdentity,
  DISPLAY_NAME_MAX,
  DEDICATION_MAX,
} from "../src/display-name.js";

test("sanitizeDisplayName trims, caps, and rejects blanks", () => {
  assert.equal(sanitizeDisplayName("  Sam  "), "Sam");
  assert.equal(sanitizeDisplayName("   "), null);
  assert.equal(sanitizeDisplayName(""), null);
  assert.equal(sanitizeDisplayName(null), null);
  assert.equal(sanitizeDisplayName("a".repeat(40)).length, DISPLAY_NAME_MAX);
  assert.equal(sanitizeDisplayName("Hi\u0000there"), "Hithere");
});

test("sanitizeDedication trims, caps, and rejects blanks", () => {
  assert.equal(sanitizeDedication("  For Jen  "), "For Jen");
  assert.equal(sanitizeDedication("   "), null);
  assert.equal(sanitizeDedication("a".repeat(100)).length, DEDICATION_MAX);
});

test("resolveGuestIdentity: empty alias falls back to User for badge", () => {
  const out = resolveGuestIdentity({
    requestedBy: "",
    requestedByUser: "Mark",
  });
  assert.equal(out.user, "Mark");
  assert.equal(out.badge, "Mark");
  assert.equal(out.alias, null);
});

test("resolveGuestIdentity: alias is badge, User stays separate", () => {
  const out = resolveGuestIdentity({
    requestedBy: "Party Dave",
    requestedByUser: "Mark",
  });
  assert.equal(out.user, "Mark");
  assert.equal(out.badge, "Party Dave");
  assert.equal(out.alias, "Party Dave");
});

test("resolveGuestIdentity: old clients send only requestedBy as both", () => {
  const out = resolveGuestIdentity({ requestedBy: "Sam" });
  assert.equal(out.user, "Sam");
  assert.equal(out.badge, "Sam");
  assert.equal(out.alias, "Sam");
});
