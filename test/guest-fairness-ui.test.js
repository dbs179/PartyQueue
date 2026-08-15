import test from "node:test";
import assert from "node:assert/strict";
import {
  guestFairnessLabel,
  retryMinutesLabel,
} from "../public/js/guest-fairness-ui.js";

test("retryMinutesLabel rounds up", () => {
  const now = 1_000_000;
  assert.equal(retryMinutesLabel(now + 1000, now), 1);
  assert.equal(retryMinutesLabel(now + 60_000, now), 1);
  assert.equal(retryMinutesLabel(now + 60_001, now), 2);
});

test("guestFairnessLabel hides when inactive", () => {
  assert.equal(guestFairnessLabel({ active: false }), "");
  assert.equal(guestFairnessLabel(null), "");
});

test("guestFairnessLabel shows remaining song and set quotas", () => {
  const label = guestFairnessLabel({
    active: true,
    song: {
      enabled: true,
      limitsActive: true,
      rollingRemaining: 3,
      upcomingActive: false,
      upcomingRemaining: 2,
    },
    setRequest: {
      enabled: true,
      rollingRemaining: 1,
    },
  });
  assert.equal(label, "Songs: 3 left · Sets: 1 left");
});

test("guestFairnessLabel prefers upcoming wait and retry copy", () => {
  const now = Date.now();
  const label = guestFairnessLabel(
    {
      active: true,
      song: {
        enabled: true,
        limitsActive: true,
        rollingRemaining: 2,
        upcomingActive: true,
        upcomingRemaining: 0,
      },
      setRequest: {
        enabled: true,
        rollingRemaining: 0,
        retryAt: now + 12 * 60_000,
      },
    },
    { now }
  );
  assert.equal(label, "Songs: wait for one of yours · Sets: wait ~12m");
});

test("guestFairnessLabel shows open when song limits are inactive", () => {
  const label = guestFairnessLabel({
    active: true,
    song: {
      enabled: true,
      limitsActive: false,
      rollingRemaining: 0,
      upcomingActive: false,
      upcomingRemaining: 0,
    },
    setRequest: { enabled: false },
  });
  assert.equal(label, "Songs: open");
});
