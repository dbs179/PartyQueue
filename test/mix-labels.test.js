import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveActiveEraMoodId,
  formatMoodMixText,
  formatGenreHeaderText,
  formatVolumeHeaderText,
  volumePollMs,
  paintVolumeLabel,
  genreHeaderHasKnownValue,
  UNKNOWN_GENRE_DISPLAY,
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
  assert.equal(
    formatGenreHeaderText(null),
    `Genre: ${UNKNOWN_GENRE_DISPLAY}`
  );
  assert.equal(genreHeaderHasKnownValue("Genre: Rock"), true);
  assert.equal(genreHeaderHasKnownValue(`Genre: ${UNKNOWN_GENRE_DISPLAY}`), false);
  assert.equal(genreHeaderHasKnownValue("Genre:"), false);
});

test("formatVolumeHeaderText and paintVolumeLabel", () => {
  assert.equal(formatVolumeHeaderText(15), "Volume: 15");
  assert.equal(formatVolumeHeaderText(0), "Volume: 0");
  assert.equal(formatVolumeHeaderText(100.4), "Volume: 100");
  assert.equal(formatVolumeHeaderText(null), "");
  assert.equal(formatVolumeHeaderText(undefined), "");
  assert.equal(volumePollMs(true), 250);
  assert.equal(volumePollMs(false), 2500);
  const el = { textContent: "", hidden: true };
  paintVolumeLabel(el, 32);
  assert.equal(el.textContent, "Volume: 32");
  assert.equal(el.hidden, false);
  paintVolumeLabel(el, null);
  assert.equal(el.hidden, true);
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

  const makeEl = () => {
    const classes = new Set();
    return {
      textContent: "",
      hidden: true,
      classList: {
        toggle(name, on) {
          if (on) classes.add(name);
          else classes.delete(name);
        },
        contains(name) {
          return classes.has(name);
        },
        add(name) {
          classes.add(name);
        },
        remove(name) {
          classes.delete(name);
        },
      },
    };
  };
  const els = {
    npMoodLabel: makeEl(),
    npGenreLabel: makeEl(),
    displayMixPill: makeEl(),
    displayGenrePill: makeEl(),
  };
  paintMixLabels(els, {
    moodText: "Mood: Party - 80's",
    genreText: "Genre: Rock",
    genreLane: "rock",
  });
  assert.equal(els.npMoodLabel.textContent, "Mood: Party - 80's");
  assert.equal(els.npMoodLabel.hidden, false);
  assert.equal(els.displayGenrePill.textContent, "Genre: Rock");
  assert.equal(els.displayGenrePill.classList.contains("is-unknown"), false);

  paintMixLabels(els, {
    moodText: "Mood: All",
    genreText: `Genre: ${UNKNOWN_GENRE_DISPLAY}`,
  });
  assert.equal(
    els.displayGenrePill.textContent,
    `Genre: ${UNKNOWN_GENRE_DISPLAY}`
  );
  assert.equal(els.displayGenrePill.classList.contains("is-unknown"), true);
  assert.equal(els.npGenreLabel.classList.contains("is-unknown"), true);
});
