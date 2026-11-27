import { Family, RouteDecision, Tier } from "./types";

export type Surface = "chat" | "inlineEdit";
export type EscalatedBy = "model" | "user";

export interface Escalation {
  from: Family;
  to: Family;
  by: EscalatedBy;
}

/** One routed turn, written as a JSON line. Collected to evaluate and later train the classifier. */
export interface DecisionLogEntry {
  ts: string;
  surface: Surface;
  /** Omitted when decisionLog.includePrompt is off. */
  prompt?: string;
  promptChars: number;
  contextBytes: number;
  /** Classifier score per difficulty tier. */
  scores?: Record<Tier, number>;
  reasons?: string[];
  /** Difficulty the classifier judged, before it was mapped to a family. */
  tier?: Tier;
  /** The first decision for this turn, before any escalation. */
  decided: { family: Family; source: RouteDecision["source"]; model: string };
  /** What actually answered. */
  served: { family: Family; model: string };
  escalations: Escalation[];
  stopReason?: string;
  /** Provider model that answered via server-side fallback, when it differs. */
  servedBy?: string;
  error?: string;
}

export interface TurnOutcome {
  surface: Surface;
  prompt: string;
  contextBytes: number;
  first: RouteDecision;
  final: RouteDecision;
  escalations: Escalation[];
  stopReason?: string;
  servedBy?: string;
  error?: string;
}

export function buildEntry(o: TurnOutcome, includePrompt: boolean, now = new Date()): DecisionLogEntry {
  return {
    ts: now.toISOString(),
    surface: o.surface,
    ...(includePrompt ? { prompt: o.prompt } : {}),
    promptChars: o.prompt.length,
    contextBytes: o.contextBytes,
    scores: o.first.classification?.scores,
    reasons: o.first.classification?.reasons,
    ...(o.first.classification ? { tier: o.first.classification.tier } : {}),
    decided: { family: o.first.family, source: o.first.source, model: o.first.providerModelId },
    served: { family: o.final.family, model: o.final.providerModelId },
    escalations: o.escalations,
    ...(o.stopReason ? { stopReason: o.stopReason } : {}),
    ...(o.servedBy ? { servedBy: o.servedBy } : {}),
    ...(o.error ? { error: o.error } : {}),
  };
}
