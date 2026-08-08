import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_END_OF_NIGHT } from "../public/js/dj-booth-ui.js";

test("DEFAULT_END_OF_NIGHT is Closing Time by Semisonic", () => {
  assert.deepEqual(DEFAULT_END_OF_NIGHT, {
    uri: null,
    name: "Closing Time",
    artist: "Semisonic",
  });
});
