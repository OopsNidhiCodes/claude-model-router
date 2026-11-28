import { BudgetMode, Family, Tier, TIERS } from "./types";

export const BUDGET_MODE_LABEL: Record<BudgetMode, string> = {
  normal: "Normal — auto routing",
  budget: "Budget — bias toward Haiku",
  quality: "Quality — bias toward Opus",
  deep: "Deep — always Opus or Fable",
};

/**
 * Per-tier confidence bar the model's own probability for that tier must
 * clear; see `decide` in classifier.ts. Tiers are walked cheapest first, so
 * the first one that clears wins — "among tiers good enough, pick the
 * cheapest" rather than "is the single most likely tier confident enough".
 *
 * The bars are uneven on purpose: routing too low costs one wasted call,
 * since escalation catches it; routing too high silently pays the higher
 * tier's price on every turn with nothing to catch it. So trivial asks for
 * less certainty and complex/expert ask for more. This "normal" table was
 * measured by leave-one-session-out CV across 6 fold splits
 * (classifier-accuracy-findings memory): it held accuracy roughly flat
 * (within the ~2-point noise floor of a 95-prompt test set) while cutting
 * over-routed cost by about a quarter versus a flat 50% bar on every tier.
 */
export const TIER_THRESHOLD: Record<Tier, number> = {
  trivial: 0.3,
  standard: 0.45,
  complex: 0.55,
  expert: 0.55,
};

/**
 * Flat adjustment applied to every TIER_THRESHOLD entry for budget/quality
 * mode. Unlike TIER_THRESHOLD itself, these numbers are a product default,
 * not a measured optimum — there is no held-out data for "how strongly should
 * budget mode prefer Haiku". They exist to give an explicit, explainable
 * direction to bias in, sized to visibly shift behaviour without being as
 * absolute as a pin (`pinnedFamily`) or a floor (`deep`, below).
 */
const THRESHOLD_SHIFT: Record<BudgetMode, Partial<Record<Tier, number>>> = {
  normal: {},
  budget: { trivial: -0.1, standard: -0.1, complex: 0.1, expert: 0.1 },
  quality: { trivial: 0.15, standard: 0.1, complex: -0.1, expert: -0.1 },
  deep: {},
};

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** The threshold table `classify`/`decide` should use for this budget mode. */
export function thresholdsFor(mode: BudgetMode): Record<Tier, number> {
  const shift = THRESHOLD_SHIFT[mode];
  const out = {} as Record<Tier, number>;
  for (const tier of TIERS) out[tier] = clamp01(TIER_THRESHOLD[tier] + (shift[tier] ?? 0));
  return out;
}

/**
 * The lowest family this mode ever allows, applied as a floor the same way an
 * escalation floor is — it can only raise the family a pin or the classifier
 * picked, never lower it, and a `/prefix` still bypasses it entirely. Only
 * "deep" has one: "always Opus or Fable" is a hard guarantee, not a bias, so
 * it cannot be expressed as a threshold shift.
 */
export function budgetFloor(mode: BudgetMode): Family | undefined {
  return mode === "deep" ? "opus" : undefined;
}
