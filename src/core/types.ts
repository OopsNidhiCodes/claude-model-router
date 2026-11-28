export type Family = "haiku" | "sonnet" | "opus" | "fable";
export const FAMILIES: readonly Family[] = ["haiku", "sonnet", "opus", "fable"];

/**
 * How hard a request is, independent of which models exist. The classifier
 * answers in these terms; `TIER_TO_FAMILY` is the only place that turns an
 * answer into a model family, so a change to the roster does not reach the
 * classifier or its training data.
 */
export type Tier = "trivial" | "standard" | "complex" | "expert";

/** Ordered easiest to hardest; the index is the class index the trained model uses. */
export const TIERS: readonly Tier[] = ["trivial", "standard", "complex", "expert"];

export const TIER_TO_FAMILY: Record<Tier, Family> = {
  trivial: "haiku",
  standard: "sonnet",
  complex: "opus",
  expert: "fable",
};

export const FAMILY_TO_TIER: Record<Family, Tier> = {
  haiku: "trivial",
  sonnet: "standard",
  opus: "complex",
  fable: "expert",
};

/**
 * Quick cost/quality preset (roadmap: "budget modes"). "budget" and "quality"
 * bias the classifier's per-tier thresholds without ever forcing a tier;
 * "deep" is a hard floor, the same mechanism an escalation floor uses, so it
 * still lets the agentic signal choose Opus vs Fable. See `src/core/budget.ts`.
 */
export type BudgetMode = "normal" | "budget" | "quality" | "deep";
export const BUDGET_MODES: readonly BudgetMode[] = ["normal", "budget", "quality", "deep"];

export type ProviderName = "anthropic" | "bedrock" | "vertex";
export type ReleaseChannel = "stable" | "experimental";
export type ModelStatus = "current" | "previous" | "deprecated";

export interface FamilyInfo {
  displayName: string;
  /** Codicon name shown in the status bar, e.g. "zap". */
  icon: string;
  /** Capability rank; used to detect "pinned lower tier for a complex task". */
  rank: number;
}

export interface ModelEntry {
  id: string;
  family: Family;
  version: string;
  displayName: string;
  channel: ReleaseChannel;
  status: ModelStatus;
  retires?: string;
  /** Supports the server-side `fallbacks: "default"` parameter on the Claude API. */
  serverFallback?: boolean;
  /** Provider-specific model strings. A missing key means "not offered on that provider". */
  providers: Partial<Record<ProviderName, string>>;
}

export interface StrictModernThresholds {
  npm: Record<string, string>;
  tsconfigTarget: string;
  python: string;
  pythonPackages: Record<string, string>;
  go: string;
}

export interface Registry {
  schemaVersion: number;
  updated: string;
  families: Record<Family, FamilyInfo>;
  models: ModelEntry[];
  retired: string[];
  retiredPatterns: string[];
  strictModern: StrictModernThresholds;
}

export type FamilyChannel = "latest" | "snapshot" | "custom";

export interface FamilyPreference {
  channel: FamilyChannel;
  /** Registry id used when channel is "snapshot". */
  snapshot?: string;
  /** Raw model string used when channel is "custom"; passed through unvalidated. */
  customModelId?: string;
}

export interface RouterSettings {
  /** "auto" lets the classifier choose; a family name pins every request to it. */
  pinnedFamily: Family | "auto";
  releaseChannel: ReleaseChannel;
  provider: ProviderName;
  families: Record<Family, FamilyPreference>;
  budgetMode: BudgetMode;
}

export interface ClassifierInput {
  prompt: string;
  /** Bytes of editor context attached to the request (selection or active file). */
  contextBytes: number;
  /** Total bytes of source in the workspace, if known. */
  workspaceBytes?: number;
  /** True when the request edits a selection in place. */
  inlineEdit?: boolean;
}

export interface Classification {
  tier: Tier;
  scores: Record<Tier, number>;
  reasons: string[];
}

export type DecisionSource = "prefix" | "pin" | "classifier" | "escalation" | "budget";

export interface RouteDecision {
  family: Family;
  /** Registry entry, when the final model string is known to the registry. */
  model?: ModelEntry;
  /** Exact string sent to the provider. */
  providerModelId: string;
  label: string;
  icon: string;
  source: DecisionSource;
  /** Prompt with any routing prefix removed. */
  prompt: string;
  classification?: Classification;
  warnings: string[];
  /** Status-bar-only notices (non-modal). */
  notices: string[];
}
