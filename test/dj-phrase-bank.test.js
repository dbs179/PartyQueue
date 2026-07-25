import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DJ_INTRO_CONTEXTS,
  DJ_SHARED_INTROS,
  DJ_SHARED_OUTROS,
  DJ_BOOTH_ASIDES,
  DJ_SET_DESCRIPTORS,
  filterIntrosByContext,
  filterAsidesByFamilySafety,
  filterDescriptorsForMood,
} from "../src/dj-phrase-bank.js";

const ALL_ENTRIES = [
  ...DJ_SHARED_INTROS,
  ...DJ_SHARED_OUTROS,
  ...DJ_BOOTH_ASIDES,
  ...DJ_SET_DESCRIPTORS,
];

const DESCRIPTOR_ENERGIES = ["high", "mid", "low", "any"];

describe("DJ phrase bank", () => {
  it("contains at least 100 intros/outros, 100 descriptors, 50 asides", () => {
    assert.ok(DJ_SHARED_INTROS.length >= 100);
    assert.ok(DJ_SHARED_OUTROS.length >= 100);
    assert.equal(DJ_SET_DESCRIPTORS.length, 100);
    assert.ok(DJ_BOOTH_ASIDES.length >= 50);
  });

  it("uses globally unique stable ids and unique text", () => {
    const ids = ALL_ENTRIES.map((entry) => entry.id);
    const texts = ALL_ENTRIES.map((entry) => entry.text);

    assert.equal(new Set(ids).size, ids.length);
    assert.equal(new Set(texts).size, texts.length);
    for (const id of ids) {
      assert.match(id, /^(intro|outro|aside|desc)-\d{3}$/);
    }
  });

  it("contains nonempty, concise, speakable text", () => {
    for (const entry of ALL_ENTRIES) {
      assert.equal(typeof entry.text, "string");
      assert.ok(entry.text.trim().length > 0);
      assert.ok(entry.text.length <= 140, `${entry.id} is too long`);
      assert.doesNotMatch(entry.text, /[\r\n]/);
    }
  });

  it("gives every intro one or more valid contexts with broad coverage", () => {
    const validContexts = new Set(DJ_INTRO_CONTEXTS);

    for (const intro of DJ_SHARED_INTROS) {
      assert.ok(Array.isArray(intro.contexts));
      assert.ok(intro.contexts.length > 0);
      assert.equal(new Set(intro.contexts).size, intro.contexts.length);
      for (const context of intro.contexts) {
        assert.ok(validContexts.has(context), `${intro.id}: ${context}`);
      }
    }

    for (const context of DJ_INTRO_CONTEXTS) {
      assert.ok(
        filterIntrosByContext(context).length >= 60,
        `${context} needs at least 60 intros`
      );
    }
  });

  it("tags every descriptor with a valid energy hint", () => {
    for (const entry of DJ_SET_DESCRIPTORS) {
      assert.ok(
        DESCRIPTOR_ENERGIES.includes(entry.energy),
        `${entry.id}: ${entry.energy}`
      );
    }
    // Every energy tier is represented so filtering never empties the pool.
    for (const energy of DESCRIPTOR_ENERGIES) {
      assert.ok(
        DJ_SET_DESCRIPTORS.some((entry) => entry.energy === energy),
        `no descriptors tagged ${energy}`
      );
    }
  });

  it("filters descriptors by mood energy fit", () => {
    const chill = filterDescriptorsForMood("chill");
    assert.ok(chill.length >= 40);
    assert.ok(chill.every((entry) => entry.energy !== "high"));

    for (const mood of ["party", "heavy", "rap"]) {
      const pool = filterDescriptorsForMood(mood);
      assert.ok(pool.length >= 40, `${mood} pool too small`);
      assert.ok(
        pool.every((entry) => entry.energy !== "low"),
        `${mood} must exclude low-energy descriptors`
      );
      assert.ok(
        pool.some((entry) => entry.energy === "any"),
        `${mood} keeps universal descriptors`
      );
    }

    // Flexible moods get the full bank.
    assert.equal(filterDescriptorsForMood("all").length, 100);
    assert.equal(filterDescriptorsForMood("custom").length, 100);
    assert.equal(filterDescriptorsForMood(null).length, 100);
  });

  it("provides at least 20 explicitly family-safe asides", () => {
    for (const aside of DJ_BOOTH_ASIDES) {
      assert.equal(typeof aside.familySafe, "boolean");
    }
    assert.ok(filterAsidesByFamilySafety(true).length >= 20);
  });

  it("filters phrase families without mutating the catalogs", () => {
    const startCount = DJ_SHARED_INTROS.length;
    const asideCount = DJ_BOOTH_ASIDES.length;
    const descriptorCount = DJ_SET_DESCRIPTORS.length;

    assert.ok(
      filterIntrosByContext("session_start").every((entry) =>
        entry.contexts.includes("session_start")
      )
    );
    assert.deepEqual(filterIntrosByContext("unsupported"), []);
    assert.ok(
      filterAsidesByFamilySafety(false).every(
        (entry) => entry.familySafe === false
      )
    );
    filterDescriptorsForMood("chill");
    assert.equal(DJ_SHARED_INTROS.length, startCount);
    assert.equal(DJ_BOOTH_ASIDES.length, asideCount);
    assert.equal(DJ_SET_DESCRIPTORS.length, descriptorCount);
  });
});
