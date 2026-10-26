import { ModelRegistry } from "./registry";
import { FAMILIES, Family, ModelEntry } from "./types";

export type PrefixResult =
  | { kind: "none"; prompt: string }
  | { kind: "family"; family: Family; prompt: string }
  | { kind: "model"; model: ModelEntry; prompt: string }
  | { kind: "unknown"; token: string };

// A leading "/word" token, e.g. "/opus", "/sonnet-5.5", "/sonnet5.5".
const PREFIX_RE = /^\s*\/([A-Za-z][\w.-]*)(?=\s|$)\s*/;
const FAMILY_RE = new RegExp(`^(${FAMILIES.join("|")})-?(.*)$`, "i");

/**
 * Extracts a routing prefix from the start of a prompt. Only tokens that start
 * with a family name are treated as routing commands; anything else ("/explain",
 * "/usr/bin/...") is left in the prompt untouched.
 */
export function parsePrefix(prompt: string, registry: ModelRegistry): PrefixResult {
  const match = PREFIX_RE.exec(prompt);
  if (!match) return { kind: "none", prompt };

  const token = match[1];
  const familyMatch = FAMILY_RE.exec(token);
  if (!familyMatch) return { kind: "none", prompt };

  const rest = prompt.slice(match[0].length);
  const family = familyMatch[1].toLowerCase() as Family;
  const version = familyMatch[2];
  if (version === "") return { kind: "family", family, prompt: rest };

  const model = registry.findAlias(`${family}-${version}`);
  return model ? { kind: "model", model, prompt: rest } : { kind: "unknown", token: `/${token}` };
}
