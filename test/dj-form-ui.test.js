import { test } from "node:test";
import assert from "node:assert/strict";
import {
  djTtsProviderRowVisibility,
  djShoutModeRowVisibility,
  paintDjTtsProviderRows,
  paintDjShoutModeRows,
} from "../public/js/dj-form-ui.js";

test("djTtsProviderRowVisibility defaults to ElevenLabs", () => {
  assert.deepEqual(djTtsProviderRowVisibility(), {
    openaiHidden: true,
    elevenlabsHidden: false,
  });
  assert.deepEqual(djTtsProviderRowVisibility("openai_ha"), {
    openaiHidden: false,
    elevenlabsHidden: true,
  });
});

test("djShoutModeRowVisibility defaults to every-N", () => {
  assert.deepEqual(djShoutModeRowVisibility(), {
    percentHidden: true,
    everyHidden: false,
  });
  assert.deepEqual(djShoutModeRowVisibility("percent"), {
    percentHidden: false,
    everyHidden: true,
  });
});

test("paint helpers set hidden flags", () => {
  const openaiRow = { hidden: false };
  const elevenlabsRow = { hidden: false };
  paintDjTtsProviderRows(
    { openaiRow, elevenlabsRow },
    "elevenlabs_ha"
  );
  assert.equal(openaiRow.hidden, true);
  assert.equal(elevenlabsRow.hidden, false);

  const percentRow = { hidden: false };
  const everyRow = { hidden: false };
  paintDjShoutModeRows({ percentRow, everyRow }, "percent");
  assert.equal(percentRow.hidden, false);
  assert.equal(everyRow.hidden, true);
});
