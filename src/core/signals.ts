import { ClassifierModel, predict } from "./features";
import { ClassifierInput, Tier } from "./types";

/**
 * Independent facts about a request. Each one is computed on its own and can be
 * tested and improved without touching the others; `decide` in classifier.ts is
 * the only place they are combined into a family.
 */

const KB = 1024;
export const SMALL_CONTEXT_BYTES = 5 * KB;
export const LARGE_CONTEXT_BYTES = 100 * KB;
export const LONG_PROMPT_CHARS = 1500;

/** One prompt can match a rule several times; past this the extra matches stop counting. */
const MAX_MATCHES_PER_RULE = 2;

export type ContextSize = "small" | "medium" | "large";

interface Rule {
  tier: Tier;
  weight: number;
  pattern: RegExp;
  reason: string;
}

// Deterministic keyword rules. Each matching rule adds its weight to its family.
// Task taxonomy adapted from opencode-model-router's coding task patterns.
const RULES: Rule[] = [
  // --- trivial (Haiku): quick lookups, trivial edits, one-line answers ---
  {
    tier: "trivial",
    weight: 3,
    pattern: /\b(typos?|spelling|regex(es)?|regular expression|docstrings?|jsdoc|comments?|rename|format(ting)?|lint|syntax error|what does (this|that|it) (do|mean)|explain (this|the|that) (error|syntax|line))\b/i,
    reason: "quick-fix / explanation intent",
  },
  {
    tier: "trivial",
    weight: 3,
    pattern: /\b(search (for|the)|grep|find (the |all |every )?(file|usage|reference|definition|occurrence)|git (log|status|diff|blame|show)|list (the |all )?(files|imports|exports|dependencies)|count (the |how many )|what('s| is) (the |this )?(type|return type|signature))\b/i,
    reason: "search / lookup task",
  },
  // --- standard (Sonnet): standard implementation work ---
  {
    tier: "standard",
    weight: 3,
    pattern: /\b(implement|build|create|add|write|generate|scaffold|(unit |integration )?tests?|endpoint|route|controller|component|handler|function|class|fix (the |this )?bug|refactor (this|the) (function|method|class|component))\b/i,
    reason: "implementation intent",
  },
  {
    tier: "standard",
    weight: 3,
    pattern: /\b(code[ -]review|review (this|the|my) (code|pr|pull request|change|diff)|write tests? for|add (error |input )?validation|add (type|typing|types)|extract (a |this )?(function|method|component|hook|module)|move (this|the) .{0,20} (to|into))\b/i,
    reason: "standard code task",
  },
  // --- complex (Opus): deep reasoning, multi-file analysis, debugging ---
  {
    tier: "complex",
    weight: 4,
    pattern: /\b(architect(ure|ural)?|design (the|a)|audit|root cause|memory leak|race condition|deadlock|security (review|audit)|vulnerabilit(y|ies)|performance bottleneck|deep(ly)?|across (the )?(codebase|files|modules|services)|multi-?file|structural|trade-?offs?|why (does|is|do))\b/i,
    reason: "deep reasoning intent",
  },
  {
    tier: "complex",
    weight: 4,
    pattern: /\b(debug(ging)?( this| the| across| why)|flaky test|intermittent(ly)?|not reproduc(ible|e)|root[- ]cause[- ]analysis|stack trace|heap dump|profil(e|ing)|flame ?graph|data (model|schema) design|system design|dependency (graph|cycle|analysis))\b/i,
    reason: "deep debugging / analysis task",
  },
  // --- expert (Fable): agentic, multi-step, long-running ---
  {
    tier: "expert",
    weight: 4,
    pattern: /\b(migrate (the|all|every|our)|iterate|until (the |all )?tests pass|keep (going|trying)|run (the )?(tests|build|commands?|scripts?)|in the terminal|step[- ]by[- ]step and (run|execute|apply)|automate|agent(ic)?|end[- ]to[- ]end|long[- ]running|multi[- ]step)\b/i,
    reason: "agentic / multi-step intent",
  },
];

const CODE_PATTERN = /[{}();=<>]|```|\b(const|let|var|def|function|import|export|class|return|async|await|SELECT|INSERT|npm|pip|git)\b|\.(ts|js|tsx|jsx|py|go|java|rb|rs|sql|json|yaml|yml)\b/i;

const CREATIVE_PATTERN = /\b(story|stories|poem|poetry|novel|fanfic|screenplay|script for|lyrics|song|limerick|haiku about|write a scene|narrative|roleplay|character|dialogue between)\b/i;

export interface IntentSignal {
  /** Keyword weight per tier, from the prompt text alone. */
  scores: Record<Tier, number>;
  reasons: string[];
}

export interface ModelSignal {
  tier: Tier;
  probs: Record<Tier, number>;
  confidence: number;
}

export interface Signals {
  /** The trained classifier's view, absent when no model is loaded. */
  model?: ModelSignal;
  /** Keyword rules over the prompt text. */
  intent: IntentSignal;
  /** How much editor context came with the request. */
  contextSize: ContextSize;
  /** Prompt itself is long enough to suggest more than a quick answer. */
  isLongPrompt: boolean;
  /** Prompt contains or concerns code. */
  hasCode: boolean;
  /** Prompt asks for creative or narrative writing. */
  isCreative: boolean;
}

export function contextSizeOf(bytes: number): ContextSize {
  if (bytes < SMALL_CONTEXT_BYTES) return "small";
  return bytes <= LARGE_CONTEXT_BYTES ? "medium" : "large";
}

/** Scores the prompt against the keyword rules. Pure text, no context size. */
export function keywordIntent(prompt: string): IntentSignal {
  const scores: Record<Tier, number> = { trivial: 0, standard: 0, complex: 0, expert: 0 };
  const reasons: string[] = [];
  for (const rule of RULES) {
    const matches = new Set(Array.from(prompt.matchAll(new RegExp(rule.pattern, "gi")), (m) => m[0].toLowerCase()));
    if (matches.size === 0) continue;
    scores[rule.tier] += rule.weight * Math.min(matches.size, MAX_MATCHES_PER_RULE);
    reasons.push(rule.reason);
  }
  return { scores, reasons };
}

export function hasCode(prompt: string): boolean {
  return CODE_PATTERN.test(prompt);
}

export function isCreative(prompt: string): boolean {
  return CREATIVE_PATTERN.test(prompt);
}

export function extractSignals(input: ClassifierInput, model?: ClassifierModel): Signals {
  const m = model ? predict(model, input.prompt) : undefined;
  return {
    model: m ? { tier: m.tier, probs: m.probs, confidence: m.confidence } : undefined,
    intent: keywordIntent(input.prompt),
    contextSize: contextSizeOf(input.contextBytes),
    isLongPrompt: input.prompt.length > LONG_PROMPT_CHARS,
    hasCode: hasCode(input.prompt),
    isCreative: isCreative(input.prompt),
  };
}

export function formatBytes(bytes: number): string {
  return bytes < KB ? `${bytes} B` : `${Math.round(bytes / KB)} KB`;
}
