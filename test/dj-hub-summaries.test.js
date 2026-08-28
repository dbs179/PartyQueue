import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDjIconLabel,
  formatDjVoiceHubLine,
  formatDjAdvancedHubLine,
  formatDjVolumeHubLine,
  formatDjShoutsHubLine,
  formatDjTaglinesHubLine,
  formatDjRosterHubLine,
  formatDjLastCallHubLine,
  formatEndOfNightLabel,
} from "../public/js/dj-hub-summaries.js";

test("formatDjIconLabel strips prefix/extension and truncates", () => {
  assert.equal(formatDjIconLabel(null), "Default");
  assert.equal(formatDjIconLabel("dj-icon-12-holy-roller.png"), "holy roller");
  assert.equal(
    formatDjIconLabel("a-very-long-dj-icon-name-that-needs-cutting.png", 20),
    "a very long dj icon…"
  );
});

test("formatDjVoiceHubLine", () => {
  assert.equal(
    formatDjVoiceHubLine({
      intensity: "extra",
      provider: "elevenlabs_ha",
      speed: 1.2,
    }),
    "Extra · ElevenLabs · 1.2×"
  );
  assert.equal(
    formatDjVoiceHubLine({
      intensity: "classic",
      provider: "openai_ha",
      speed: "nope",
    }),
    "Classic · OpenAI · 1×"
  );
});

test("formatDjAdvancedHubLine", () => {
  assert.equal(formatDjAdvancedHubLine({}), "Core locked");
  assert.equal(
    formatDjAdvancedHubLine({
      personaNotes: "Be funny",
      pronunciations: "Foo => Foo\nBar = Bar\n# skip",
    }),
    "1 guidance · 2 pronunciations"
  );
});

test("formatDjVolumeHubLine and formatDjShoutsHubLine", () => {
  assert.equal(
    formatDjVolumeHubLine({ low: 10, mid: 20, high: 30, silence: 3 }),
    "10/20/30% · 3s"
  );
  assert.equal(
    formatDjShoutsHubLine({ mode: "every", everyN: 7 }),
    "Every 7"
  );
  assert.equal(
    formatDjShoutsHubLine({ mode: "percent", percent: 40 }),
    "40% of the time"
  );
});

test("formatDjTaglinesHubLine counts lines", () => {
  assert.equal(formatDjTaglinesHubLine([]), "0 lines");
  assert.equal(formatDjTaglinesHubLine(["Rocking from the Pulpit"]), "1 line");
  assert.equal(
    formatDjTaglinesHubLine("Bringing that Heat\n\nRocking from the Pulpit\n"),
    "2 lines"
  );
});

test("formatDjRosterHubLine", () => {
  assert.equal(formatDjRosterHubLine({}), "Holy Roller");
  assert.equal(
    formatDjRosterHubLine({ mode: "sister-static" }),
    "Sister Static"
  );
  assert.equal(
    formatDjRosterHubLine({ mode: "mix", mixHr: 70, banter: 15 }),
    "Mix · 70/30 · Banter 15%"
  );
});

test("formatDjLastCallHubLine and formatEndOfNightLabel", () => {
  assert.equal(formatDjLastCallHubLine("Closing Time"), "Closing Time");
  assert.equal(
    formatDjLastCallHubLine("A Really Long Closing Song Title"),
    "A Really Long Closin…"
  );
  assert.equal(
    formatEndOfNightLabel({ name: "Closing Time", artist: "Semisonic" }),
    "Closing Time — Semisonic (default)"
  );
  assert.equal(
    formatEndOfNightLabel({
      name: "Closing Time",
      artist: "Semisonic",
      uri: "x-sonos-spotify:spotify:track:abc",
    }),
    "Closing Time — Semisonic"
  );
});
