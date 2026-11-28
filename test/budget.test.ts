import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { budgetFloor, thresholdsFor, TIER_THRESHOLD } from "../src/core/budget";
import { ClassifierModel } from "../src/core/features";
import { route } from "../src/core/router";
import { ModelRegistry, validateRegistry } from "../src/core/registry";
import { BUDGET_MODES, FAMILIES, RouterSettings, TIERS } from "../src/core/types";

const root = join(__dirname, "..", "..");
const rawRegistry = JSON.parse(readFileSync(join(root, "resources", "models-registry.json"), "utf8"));
const registry = new ModelRegistry(validateRegistry(structuredClone(rawRegistry)));

function settings(overrides: Partial<RouterSettings> = {}): RouterSettings {
  const families = Object.fromEntries(FAMILIES.map((f) => [f, { channel: "latest" }])) as RouterSettings["families"];
  return { pinnedFamily: "auto", releaseChannel: "stable", provider: "anthropic", families, budgetMode: "normal", ...overrides };
}

describe("budget thresholds", () => {
  it("leaves 'normal' identical to the base table", () => {
    assert.deepEqual(thresholdsFor("normal"), TIER_THRESHOLD);
  });

  it("shifts 'budget' toward cheap tiers: lower bar below, higher bar above", () => {
    const t = thresholdsFor("budget");
    assert.ok(t.trivial < TIER_THRESHOLD.trivial);
    assert.ok(t.standard < TIER_THRESHOLD.standard);
    assert.ok(t.complex > TIER_THRESHOLD.complex);
    assert.ok(t.expert > TIER_THRESHOLD.expert);
  });

  it("shifts 'quality' toward expensive tiers: higher bar below, lower bar above", () => {
    const t = thresholdsFor("quality");
    assert.ok(t.trivial > TIER_THRESHOLD.trivial);
    assert.ok(t.standard > TIER_THRESHOLD.standard);
    assert.ok(t.complex < TIER_THRESHOLD.complex);
    assert.ok(t.expert < TIER_THRESHOLD.expert);
  });

  it("leaves 'deep' thresholds unchanged; it works via the floor instead", () => {
    assert.deepEqual(thresholdsFor("deep"), TIER_THRESHOLD);
  });

  it("clamps shifted thresholds to [0, 1]", () => {
    for (const mode of BUDGET_MODES) {
      const t = thresholdsFor(mode);
      for (const tier of TIERS) assert.ok(t[tier] >= 0 && t[tier] <= 1, `${mode}.${tier} = ${t[tier]}`);
    }
  });

  it("only 'deep' has a floor; it is opus", () => {
    assert.equal(budgetFloor("normal"), undefined);
    assert.equal(budgetFloor("budget"), undefined);
    assert.equal(budgetFloor("quality"), undefined);
    assert.equal(budgetFloor("deep"), "opus");
  });
});

describe("budget mode in the router", () => {
  const base = { contextBytes: 2 * 1024, strictModern: false };

  it("deep mode raises a trivial-looking request to opus, with a budget notice", () => {
    const d = route(registry, { ...base, prompt: "fix typo", settings: settings({ budgetMode: "deep" }) });
    assert.equal(d.family, "opus");
    assert.equal(d.source, "budget");
    assert.deepEqual(d.notices, ['$(database) Budget mode "deep": using Opus or higher']);
  });

  it("deep mode raises a pin too, but never lowers a result already at or above its floor", () => {
    const pinnedLow = route(registry, { ...base, prompt: "fix typo", settings: settings({ budgetMode: "deep", pinnedFamily: "haiku" }) });
    assert.equal(pinnedLow.family, "opus");
    const pinnedHigh = route(registry, { ...base, prompt: "fix typo", settings: settings({ budgetMode: "deep", pinnedFamily: "fable" }) });
    assert.equal(pinnedHigh.family, "fable");
    assert.equal(pinnedHigh.source, "pin");
  });

  it("deep mode still lets the agentic signal choose fable over opus", () => {
    const d = route(registry, {
      ...base,
      prompt: "migrate every module and iterate until the tests pass",
      settings: settings({ budgetMode: "deep" }),
    });
    assert.equal(d.family, "fable");
    // Classifier (via rules) already chose fable, at or above the floor, so the floor never fires.
    assert.notEqual(d.source, "budget");
  });

  it("an escalation floor and a budget floor combine to the higher of the two", () => {
    const d = route(registry, {
      ...base,
      prompt: "fix typo",
      settings: settings({ budgetMode: "deep" }),
      minFamily: "sonnet",
    });
    assert.equal(d.family, "opus");
  });

  it("a /prefix bypasses the budget floor entirely", () => {
    const d = route(registry, { ...base, prompt: "/haiku hi", settings: settings({ budgetMode: "deep" }) });
    assert.equal(d.family, "haiku");
    assert.equal(d.source, "prefix");
  });

  it("routes the shifted thresholds through to the trained model, not just the floor", () => {
    // Empty vocab: no feature ever matches, so every prompt gets this exact
    // probability vector regardless of its text — isolating the threshold shift
    // from anything the prompt itself might also trigger via the keyword rules.
    const model: ClassifierModel = {
      version: 1,
      classes: ["trivial", "standard", "complex", "expert"],
      vocab: {},
      weights: [],
      bias: [Math.log(0.4), Math.log(0.56), Math.log(0.03), Math.log(0.01)],
    };
    // trivial (40%) clears its normal bar (30%) before standard is even checked.
    const normal = route(registry, { ...base, prompt: "fix typo", settings: settings({ budgetMode: "normal" }), model });
    assert.equal(normal.family, "haiku");
    // quality raises trivial's bar to 45%, which 40% no longer clears; standard's
    // bar also rises, to 55%, but 56% still clears it.
    const quality = route(registry, { ...base, prompt: "fix typo", settings: settings({ budgetMode: "quality" }), model });
    assert.equal(quality.family, "sonnet");
  });
});
