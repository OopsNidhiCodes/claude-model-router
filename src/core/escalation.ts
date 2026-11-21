import { Family } from "./types";

/**
 * Escalation: a request that looked easy but turned out hard is re-run one
 * tier up. Triggered by the model replying with ESCALATE_TOKEN, or by the user.
 */
export const ESCALATION_ORDER: readonly Family[] = ["haiku", "sonnet", "opus", "fable"];

export const ESCALATE_TOKEN = "ESCALATE";

/** Appended to system prompts so a model can hand off instead of guessing. */
export const ESCALATION_INSTRUCTION =
  `Answer the request yourself whenever you can; almost every request should be answered. ` +
  `Only if you genuinely cannot do it reliably because it needs far deeper reasoning or far more multi-step work than you are capable of, ` +
  `reply with exactly the single word ${ESCALATE_TOKEN} and nothing else, and a more capable model will take over. ` +
  `Never use it for tasks that are merely long, vague or unfamiliar.`;

/**
 * System prompt for a given tier: the handoff instruction is added only when
 * there is a tier above, so the top model always answers.
 */
export function systemPromptFor(base: string, family: Family): string {
  return nextFamily(family) ? `${base} ${ESCALATION_INSTRUCTION}` : base;
}

/** The next tier up, or undefined at the top. */
export function nextFamily(family: Family): Family | undefined {
  return ESCALATION_ORDER[ESCALATION_ORDER.indexOf(family) + 1];
}

/** True when `a` is a higher tier than `b`. */
export function isAbove(a: Family, b: Family): boolean {
  return ESCALATION_ORDER.indexOf(a) > ESCALATION_ORDER.indexOf(b);
}

/** True when a reply is the model asking to escalate. Tolerates whitespace, punctuation and Markdown emphasis. */
export function isEscalationRequest(text: string): boolean {
  return new RegExp(`^[\\s*_\`]*${ESCALATE_TOKEN}[\\s*_\`.!]*$`, "i").test(text) && text.trim().length <= ESCALATE_TOKEN.length + 8;
}
