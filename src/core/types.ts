export type Family = "haiku" | "sonnet" | "opus" | "fable";
export const FAMILIES: readonly Family[] = ["haiku", "sonnet", "opus", "fable"];

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
  family: Family;
  scores: Record<Family, number>;
  reasons: string[];
}

export type DecisionSource = "prefix" | "pin" | "classifier";

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
