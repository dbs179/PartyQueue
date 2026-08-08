import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveActiveEraMoodId,
  formatMoodMixText,
  formatGenreHeaderText,
  buildMixLabelTexts,
  resolveMixGenreLabelFromNowPlaying,
  mixSelectionPatchFromParty,
  formatMixHubMoodLine,
  formatSelectedOfTotal,
  paintMixLabels,
} from "../public/js/mix-labels.js";

test("resolveActiveEraMoodId prefers server when defined", () => {
  assert.equal(resolveActiveEraMoodId("80s", "90s"), "80s");
  assert.equal(resolveActiveEraMoodId(null, "90s"), null);
  assert.equal(resolveActiveEraMoodId(undefined, "90s"), "90s");
});

test("formatMoodMixText and formatGenreHeaderText", () => {
  assert.equal(formatMoodMixText("Party", "80's"), "Mood: Party - 80's");
  assert.equal(formatMoodMixText("Custom", null), "Mood: Custom");
  assert.equal(formatGenreHeaderText("Rock"), "Genre: Rock");
  assert.equal(formatGenreHeaderText(null), "Genre:");
});

test("buildMixLabelTexts uses local genres/mood when server unset", () => {
  const texts = buildMixLabelTexts(
    { genres: undefined, mood: undefined, genreLabel: "Rock" },
    {
      localGenres: ["rock", "metal", "country", "hiphop", "electronic", "pop", "punk"],
      localMood: "80s",
      allBucketIds: [
        "rock",
        "metal",
        "country",
        "hiphop",
        "electronic",
        "pop",
        "punk",
      ],
    }
  );
  assert.equal(texts.moodText, "Mood: Party - 80's");
  assert.equal(texts.genreText, "Genre: Rock");
});

test("resolveMixGenreLabelFromNowPlaying and mixSelectionPatchFromParty", () => {
  assert.equal(resolveMixGenreLabelFromNowPlaying({}), undefined);
  assert.equal(
    resolveMixGenreLabelFromNowPlaying({ mixGenreLabel: "Rock" }),
    "Rock"
  );
  assert.equal(
    resolveMixGenreLabelFromNowPlaying({ mixGenreLane: "metal" }),
    "metal"
  );
  assert.equal(
    resolveMixGenreLabelFromNowPlaying({
      mixGenreLabel: "",
      mixGenreLane: "",
    }),
    null
  );

  assert.equal(mixSelectionPatchFromParty({ neverEnding: true }), null);
  assert.deepEqual(
    mixSelectionPatchFromParty({ mixGenres: ["rock"], mixMood: "70s" }),
    { genres: ["rock"], mood: "70s" }
  );
});

test("hub formatters and paintMixLabels", () => {
  assert.equal(formatMixHubMoodLine("Party", "80's"), "Party \u00b7 80's");
  assert.equal(formatMixHubMoodLine(null, null), "—");
  assert.equal(formatSelectedOfTotal(3, 10), "3 of 10 selected");
  assert.equal(formatSelectedOfTotal(0, 0), "—");

  const els = {
    npMoodLabel: { textContent: "", hidden: true },
    npGenreLabel: { textContent: "", hidden: true },
    displayMixPill: { textContent: "", hidden: true },
    displayGenrePill: { textContent: "", hidden: true },
  };
  paintMixLabels(els, {
    moodText: "Mood: Party - 80's",
    genreText: "Genre: Rock",
  });
  assert.equal(els.npMoodLabel.textContent, "Mood: Party - 80's");
  assert.equal(els.npMoodLabel.hidden, false);
  assert.equal(els.displayGenrePill.textContent, "Genre: Rock");
});
