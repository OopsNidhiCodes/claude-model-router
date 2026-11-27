import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decide, decideByRules, MODEL_MIN_CONFIDENCE } from "../src/core/classifier";
import {
  contextSizeOf,
  extractSignals,
  hasCode,
  isCreative,
  keywordIntent,
  LARGE_CONTEXT_BYTES,
  LONG_PROMPT_CHARS,
  Signals,
  SMALL_CONTEXT_BYTES,
} from "../src/core/signals";

const KB = 1024;

/** Signals with nothing firing, so a test can set just the one it cares about. */
function emptySignals(overrides: Partial<Signals> = {}): Signals {
  return {
    intent: { scores: { trivial: 0, standard: 0, complex: 0, expert: 0 }, reasons: [] },
    contextSize: "small",
    isLongPrompt: false,
    hasCode: false,
    isCreative: false,
    ...overrides,
  };
}

describe("signal: contextSize", () => {
  it("splits at the small and large thresholds", () => {
    assert.equal(contextSizeOf(0), "small");
    assert.equal(contextSizeOf(SMALL_CONTEXT_BYTES - 1), "small");
    assert.equal(contextSizeOf(SMALL_CONTEXT_BYTES), "medium");
    assert.equal(contextSizeOf(LARGE_CONTEXT_BYTES), "medium");
    assert.equal(contextSizeOf(LARGE_CONTEXT_BYTES + 1), "large");
  });
});

describe("signal: keywordIntent", () => {
  it("scores only from the prompt text, never from context size", () => {
    const intent = keywordIntent("fix the typo in this comment");
    assert.ok(intent.scores.trivial > 0);
    assert.equal(intent.scores.complex, 0);
  });

  it("credits each distinct match but caps a single rule's contribution", () => {
    const once = keywordIntent("rename this variable");
    const many = keywordIntent("rename this variable, fix the typos, check the spelling, and the docstrings too");
    assert.ok(many.scores.trivial > once.scores.trivial);
    assert.ok(many.scores.trivial <= once.scores.trivial * 2, "one rule should not run away with the score");
  });

  it("recognises the coding task taxonomy", () => {
    assert.ok(keywordIntent("grep for every usage of this helper").scores.trivial > 0);
    assert.ok(keywordIntent("write tests for the parser").scores.standard > 0);
    assert.ok(keywordIntent("debug why the suite is flaky").scores.complex > 0);
    assert.ok(keywordIntent("migrate every module and run the tests").scores.expert > 0);
  });

  it("returns a reason for each rule that fires", () => {
    const intent = keywordIntent("audit this authentication flow for vulnerabilities");
    assert.ok(intent.reasons.length > 0);
    assert.ok(intent.reasons.every((r) => typeof r === "string" && r.length > 0));
  });

  it("scores nothing for a prompt that matches no rule", () => {
    const intent = keywordIntent("hello there");
    assert.deepEqual(intent.scores, { trivial: 0, standard: 0, complex: 0, expert: 0 });
    assert.deepEqual(intent.reasons, []);
  });
});

describe("signal: hasCode", () => {
  it("detects code punctuation, fences, keywords and file extensions", () => {
    assert.equal(hasCode("const x = 1;"), true);
    assert.equal(hasCode("```\nprint(1)\n```"), true);
    assert.equal(hasCode("update main.py please"), true);
    assert.equal(hasCode("run npm install"), true);
  });

  it("stays false for ordinary prose", () => {
    assert.equal(hasCode("what is the capital of australia"), false);
    assert.equal(hasCode("remind me to call the dentist"), false);
  });
});

describe("signal: isCreative", () => {
  it("detects narrative requests", () => {
    assert.equal(isCreative("write a story about a brave turtle"), true);
    assert.equal(isCreative("give me a poem about autumn"), true);
    assert.equal(isCreative("write a dialogue between two rivals"), true);
  });

  it("stays false for engineering work", () => {
    assert.equal(isCreative("refactor this function"), false);
    assert.equal(isCreative("why is the query slow"), false);
  });
});

describe("signal extraction", () => {
  it("reports every signal for one request", () => {
    const signals = extractSignals({
      prompt: "write a story about a deadlock in main.go",
      contextBytes: 10 * KB,
    });
    assert.equal(signals.contextSize, "medium");
    assert.equal(signals.hasCode, true);
    assert.equal(signals.isCreative, true);
    assert.equal(signals.isLongPrompt, false);
    assert.equal(signals.model, undefined, "no model loaded means no model signal");
  });

  it("flags a long prompt past the threshold", () => {
    const long = "a".repeat(LONG_PROMPT_CHARS + 1);
    assert.equal(extractSignals({ prompt: long, contextBytes: 0 }).isLongPrompt, true);
    assert.equal(extractSignals({ prompt: "a", contextBytes: 0 }).isLongPrompt, false);
  });
});

describe("decision table", () => {
  it("adds the context-size weight to the matching family", () => {
    const small = decideByRules(emptySignals({ contextSize: "small" }), 1 * KB);
    assert.equal(small.tier, "trivial");
    const large = decideByRules(emptySignals({ contextSize: "large" }), 200 * KB);
    assert.equal(large.tier, "complex");
  });

  it("pools opus and fable, splitting toward the agentic signal", () => {
    const agentic = decideByRules(
      emptySignals({ intent: { scores: { trivial: 0, standard: 0, complex: 1, expert: 4 }, reasons: [] } }),
      1 * KB,
    );
    assert.equal(agentic.tier, "expert");
    const reasoning = decideByRules(
      emptySignals({ intent: { scores: { trivial: 0, standard: 0, complex: 4, expert: 1 }, reasons: [] } }),
      1 * KB,
    );
    assert.equal(reasoning.tier, "complex");
  });

  it("trusts a confident model and reports its percentage", () => {
    const signals = emptySignals({
      model: { tier: "complex", confidence: 0.9, probs: { trivial: 0.02, standard: 0.04, complex: 0.9, expert: 0.04 } },
      intent: { scores: { trivial: 9, standard: 0, complex: 0, expert: 0 }, reasons: [] },
    });
    const result = decide(signals, 1 * KB);
    assert.equal(result.tier, "complex", "a confident model wins over the keyword rules");
    assert.equal(result.scores.complex, 90);
    assert.match(result.reasons[0], /^model 90% complex$/);
  });

  it("falls back to the rules when the model is unsure, and says so", () => {
    const signals = emptySignals({
      model: {
        tier: "complex",
        confidence: MODEL_MIN_CONFIDENCE - 0.01,
        probs: { trivial: 0.26, standard: 0.25, complex: 0.49, expert: 0 },
      },
      intent: { scores: { trivial: 9, standard: 0, complex: 0, expert: 0 }, reasons: ["quick-fix / explanation intent"] },
    });
    const result = decide(signals, 1 * KB);
    assert.equal(result.tier, "trivial");
    assert.match(result.reasons[0], /model unsure/);
    assert.ok(result.reasons.includes("quick-fix / explanation intent"));
  });
});
