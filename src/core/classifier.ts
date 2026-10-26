import { Classification, ClassifierInput, Family } from "./types";

const KB = 1024;
export const SMALL_CONTEXT_BYTES = 5 * KB;
export const LARGE_CONTEXT_BYTES = 100 * KB;
const MAX_MATCHES_PER_RULE = 2;

interface Rule {
  family: Family;
  weight: number;
  pattern: RegExp;
  reason: string;
}

// Deterministic keyword rules. Each matching rule adds its weight to its family.
const RULES: Rule[] = [
  {
    family: "haiku",
    weight: 3,
    pattern: /\b(typos?|spelling|regex(es)?|regular expression|docstrings?|jsdoc|comments?|rename|format(ting)?|lint|syntax error|what does (this|that|it) (do|mean)|explain (this|the|that) (error|syntax|line))\b/i,
    reason: "quick-fix / explanation intent",
  },
  {
    family: "sonnet",
    weight: 3,
    pattern: /\b(implement|build|create|add|write|generate|scaffold|(unit |integration )?tests?|endpoint|route|controller|component|handler|function|class|fix (the |this )?bug|refactor (this|the) (function|method|class|component))\b/i,
    reason: "implementation intent",
  },
  {
    family: "opus",
    weight: 4,
    pattern: /\b(architect(ure|ural)?|design (the|a)|audit|root cause|memory leak|race condition|deadlock|security (review|audit)|vulnerabilit(y|ies)|performance bottleneck|deep(ly)?|across (the )?(codebase|files|modules|services)|multi-?file|structural|trade-?offs?|why (does|is|do))\b/i,
    reason: "deep reasoning intent",
  },
  {
    family: "fable",
    weight: 4,
    pattern: /\b(migrate (the|all|every|our)|iterate|until (the |all )?tests pass|keep (going|trying)|run (the )?(tests|build|commands?|scripts?)|in the terminal|step[- ]by[- ]step and (run|execute|apply)|automate|agent(ic)?|end[- ]to[- ]end|long[- ]running|multi[- ]step)\b/i,
    reason: "agentic / multi-step intent",
  },
];

// Ties resolve toward the more reliable middle tier first.
const TIE_ORDER: Family[] = ["sonnet", "opus", "fable", "haiku"];

export function classify(input: ClassifierInput): Classification {
  const scores: Record<Family, number> = { haiku: 0, sonnet: 0, opus: 0, fable: 0 };
  const reasons: string[] = [];

  if (input.contextBytes < SMALL_CONTEXT_BYTES) {
    scores.haiku += 2;
    reasons.push(`small context (${formatBytes(input.contextBytes)})`);
  } else if (input.contextBytes <= LARGE_CONTEXT_BYTES) {
    scores.sonnet += 2;
    reasons.push(`standard context (${formatBytes(input.contextBytes)})`);
  } else {
    scores.opus += 2;
    reasons.push(`deep context (${formatBytes(input.contextBytes)})`);
  }

  // Each distinct match counts, capped so one long prompt can't run away with a tier.
  for (const rule of RULES) {
    const matches = new Set(Array.from(input.prompt.matchAll(new RegExp(rule.pattern, "gi")), (m) => m[0].toLowerCase()));
    if (matches.size > 0) {
      scores[rule.family] += rule.weight * Math.min(matches.size, MAX_MATCHES_PER_RULE);
      reasons.push(rule.reason);
    }
  }

  if (input.prompt.length > 1500) {
    scores.sonnet += 1;
    reasons.push("long prompt");
  }

  // Opus and Fable share the top tier: pool their score, then split by the
  // agentic-vs-reasoning signal, defaulting to Opus.
  const topTier = scores.opus + scores.fable;
  const topFamily: Family = scores.fable > scores.opus ? "fable" : "opus";
  const contenders: [Family, number][] = [
    ["haiku", scores.haiku],
    ["sonnet", scores.sonnet],
    [topFamily, topTier],
  ];
  contenders.sort((a, b) => b[1] - a[1] || TIE_ORDER.indexOf(a[0]) - TIE_ORDER.indexOf(b[0]));

  return { family: contenders[0][0], scores, reasons };
}

function formatBytes(bytes: number): string {
  return bytes < KB ? `${bytes} B` : `${Math.round(bytes / KB)} KB`;
}
