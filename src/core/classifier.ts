import { ClassifierModel } from "./features";
import {
  ContextSize,
  extractSignals,
  formatBytes,
  LARGE_CONTEXT_BYTES,
  Signals,
  SMALL_CONTEXT_BYTES,
} from "./signals";
import { Classification, ClassifierInput, Tier, TIERS } from "./types";

export { LARGE_CONTEXT_BYTES, SMALL_CONTEXT_BYTES };

/**
 * Per-tier confidence bar the model's own probability for that tier must clear.
 * Tiers are walked cheapest first (`TIERS` order), so the first one that clears
 * wins — "among tiers good enough, pick the cheapest" rather than "is the single
 * most likely tier confident enough".
 *
 * The bars are uneven on purpose: routing too low costs one wasted call, since
 * escalation catches it; routing too high silently pays the higher tier's price
 * on every turn with nothing to catch it. So trivial asks for less certainty and
 * complex/expert ask for more. Measured by leave-one-session-out CV across 6 fold
 * splits (classifier-accuracy-findings memory): this vector held accuracy
 * roughly flat (within the ~2-point noise floor of a 95-prompt test set) while
 * cutting over-routed cost by about a quarter versus a flat 50% bar on every
 * tier — a structural win independent of that noise.
 */
export const TIER_THRESHOLD: Record<Tier, number> = {
  trivial: 0.3,
  standard: 0.45,
  complex: 0.55,
  expert: 0.55,
};

/** Weight a context size contributes, and to which tier. */
const CONTEXT_WEIGHT: Record<ContextSize, { tier: Tier; weight: number; label: string }> = {
  small: { tier: "trivial", weight: 2, label: "small context" },
  medium: { tier: "standard", weight: 2, label: "standard context" },
  large: { tier: "complex", weight: 2, label: "deep context" },
};

const LONG_PROMPT_TIER: Tier = "standard";
const LONG_PROMPT_WEIGHT = 1;

// Ties resolve toward the more reliable middle tier first.
const TIE_ORDER: Tier[] = ["standard", "complex", "expert", "trivial"];

/**
 * Judges how hard a request is. With a trained model, the cheapest tier whose
 * own probability clears its threshold wins; otherwise (or when none clear) the
 * keyword rules and the other signals decide. The result is a difficulty tier,
 * never a model name — router.ts maps it to a family.
 */
export function classify(input: ClassifierInput, model?: ClassifierModel): Classification {
  return decide(extractSignals(input, model), input.contextBytes);
}

/**
 * The one place signals become a tier. Keeping it separate from signal
 * extraction means a routing policy can be changed and tested on its own.
 */
export function decide(signals: Signals, contextBytes: number): Classification {
  if (signals.model) {
    for (const tier of TIERS) {
      const p = signals.model.probs[tier] ?? 0;
      if (p >= TIER_THRESHOLD[tier]) {
        return { tier, scores: percentScores(signals.model.probs), reasons: [`model ${Math.round(p * 100)}% ${tier}`] };
      }
    }
  }

  const fallback = decideByRules(signals, contextBytes);
  if (!signals.model) return fallback;

  const pct = Math.round(signals.model.confidence * 100);
  return {
    ...fallback,
    reasons: [`model unsure (${pct}% ${signals.model.tier}), keyword rules`, ...fallback.reasons],
  };
}

/** The deterministic path: keyword intent plus context size and prompt length. */
export function decideByRules(signals: Signals, contextBytes: number): Classification {
  const scores: Record<Tier, number> = { ...signals.intent.scores };
  const reasons: string[] = [];

  const ctx = CONTEXT_WEIGHT[signals.contextSize];
  scores[ctx.tier] += ctx.weight;
  reasons.push(`${ctx.label} (${formatBytes(contextBytes)})`);

  reasons.push(...signals.intent.reasons);

  if (signals.isLongPrompt) {
    scores[LONG_PROMPT_TIER] += LONG_PROMPT_WEIGHT;
    reasons.push("long prompt");
  }

  return { tier: pickTier(scores), scores, reasons };
}

/**
 * Complex and expert share the top tier: pool their score, then split by the
 * agentic-vs-reasoning signal, defaulting to complex.
 */
function pickTier(scores: Record<Tier, number>): Tier {
  const topTier: Tier = scores.expert > scores.complex ? "expert" : "complex";
  const contenders: [Tier, number][] = [
    ["trivial", scores.trivial],
    ["standard", scores.standard],
    [topTier, scores.complex + scores.expert],
  ];
  contenders.sort((a, b) => b[1] - a[1] || TIE_ORDER.indexOf(a[0]) - TIE_ORDER.indexOf(b[0]));
  return contenders[0][0];
}

function percentScores(probs: Record<Tier, number>): Record<Tier, number> {
  const scores = { trivial: 0, standard: 0, complex: 0, expert: 0 } as Record<Tier, number>;
  for (const t of Object.keys(scores) as Tier[]) scores[t] = Math.round((probs[t] ?? 0) * 100);
  return scores;
}

/** Kept for callers and tests that work from a raw input rather than signals. */
export function classifyByRules(input: ClassifierInput): Classification {
  return decideByRules(extractSignals(input), input.contextBytes);
}
