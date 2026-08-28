import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findGluedOutro,
  lintAnnounceScript,
  lintAnnounceBatch,
} from "../src/dj-announce-copy-lint.js";

const SHINEDOWN =
  "The queue found its second wind. Back to the music. Get ready for a wild ride start-to-finish with five tracks that pack a punch, blending that epic rock energy and pop heat. We’re diving right in with Shinedown's \"Fly from the Inside\" — it’s gonna be a Keep the good mood exactly where it is.";

const PUTH =
  "You bring the energy, I'll bring the tracks. Get ready for a fresh mix that captures those front-porch vibes over five tracks of party magic. We’re diving in with Charlie Puth’s \"Marvin Gaye,\" and trust me, there’s a couple of fun discoveries waiting for That's all from the booth — the music has it covered.";

const HU =
  "The soundtrack takes another confident step. Get ready to feel that floor-ready energy as we dive into a story-first set with five tracks packed full of celebration mode. We’re kicking this off with The HU's \"Lost Soul,\" so keep those hands up and let the momentum Keep your dancing shoes where you can reach them.";

const CLEAN =
  "The queue found its second wind. Back to the music. A wild ride all the way through with five tracks that pack a punch. Keep the good mood exactly where it is.";

describe("dj-announce-copy-lint", () => {
  it("flags the Shinedown refill glue, quotes, slogan, and get-ready", () => {
    assert.ok(findGluedOutro(SHINEDOWN));
    const ids = lintAnnounceScript(SHINEDOWN).map((issue) => issue.id);
    assert.ok(ids.includes("glued-outro"), ids.join(","));
    assert.ok(ids.includes("quotes"), ids.join(","));
    assert.ok(ids.includes("slogan"), ids.join(","));
    assert.ok(ids.includes("get-ready"), ids.join(","));
  });

  it("flags the Charlie Puth and HU announces too", () => {
    const puth = lintAnnounceScript(PUTH).map((issue) => issue.id);
    assert.ok(puth.includes("glued-outro"));
    assert.ok(puth.includes("quotes"));
    assert.ok(puth.includes("slogan"));
    assert.ok(puth.includes("trust-me"));
    assert.ok(puth.includes("party-magic"));

    const hu = lintAnnounceScript(HU).map((issue) => issue.id);
    assert.ok(hu.includes("glued-outro"));
    assert.ok(hu.includes("quotes"));
    assert.ok(hu.includes("get-ready"));
  });

  it("accepts a cleaned replay of the Shinedown refill", () => {
    assert.equal(findGluedOutro(CLEAN), null);
    const fails = lintAnnounceScript(CLEAN).filter((i) => i.severity === "fail");
    assert.deepEqual(fails, []);
  });

  it("flags repeated intros and shared punchlines across a batch", () => {
    const report = lintAnnounceBatch([
      "Fresh signal from the booth. A sunny stretch, starting with Prince. Onward.",
      "Fresh signal from the booth. Another sunny stretch, starting with Queen. Let it roll from here.",
      "The speakers have the floor. A sunny stretch, starting with Prince. The groove takes it from here.",
    ]);
    const ids = report.repeats.map((issue) => issue.id);
    assert.ok(ids.includes("repeat-intro"), ids.join(","));
    assert.ok(report.failCount >= 1);
  });
});
