import { classify } from "./classifier";
import { parsePrefix } from "./prefix";
import { familyFromModelId, ModelRegistry } from "./registry";
import { Classification, ClassifierInput, Family, ModelEntry, RouteDecision, RouterSettings } from "./types";
import { generationOf } from "./version";

export const LEGACY_MAPPED_WARNING = "Legacy Model ID mapped to production counterpart.";

/** A routing failure that should abort the request (unknown prefix, model not offered on provider). */
export class RoutingError extends Error {}

export interface RouteRequest {
  prompt: string;
  contextBytes: number;
  inlineEdit?: boolean;
  settings: RouterSettings;
  /** Result of the workspace scan; true upgrades legacy-generation pins. */
  strictModern: boolean;
}

interface Resolved {
  model?: ModelEntry;
  /** Set only for custom ids the registry doesn't know; passed through as-is. */
  passthroughId?: string;
}

/**
 * Evaluates the routing chain top-down:
 *   1. prompt prefix   (bypasses every other rule)
 *   2. settings pin    (pinned family and per-family version choice)
 *   3. workspace rules (strict-modern upgrades legacy generations, family preserved)
 *   4. local classifier
 */
export function route(registry: ModelRegistry, req: RouteRequest): RouteDecision {
  const { settings } = req;
  const warnings: string[] = [];
  const notices: string[] = [];

  const prefix = parsePrefix(req.prompt, registry);
  if (prefix.kind === "unknown") throw new RoutingError(`Unknown routing prefix: ${prefix.token}`);

  if (prefix.kind === "family" || prefix.kind === "model") {
    const model = prefix.kind === "model" ? prefix.model : registry.latest(prefix.family, settings.releaseChannel);
    noteDeprecation(model, warnings);
    return finish(registry, req, { model }, model.family, "prefix", prefix.prompt, undefined, warnings, notices);
  }

  const classifierInput: ClassifierInput = { prompt: req.prompt, contextBytes: req.contextBytes, inlineEdit: req.inlineEdit };
  const classification = classify(classifierInput);

  let family: Family;
  let source: RouteDecision["source"];
  if (settings.pinnedFamily !== "auto") {
    family = settings.pinnedFamily;
    source = "pin";
    if (registry.family(classification.family).rank > registry.family(family).rank) {
      notices.push(`$(warning) Using pinned ${registry.family(family).displayName} for complex task`);
    }
  } else {
    family = classification.family;
    source = "classifier";
  }

  const resolved = resolveFamily(registry, family, settings, req.strictModern, warnings, notices);
  return finish(registry, req, resolved, family, source, req.prompt, classification, warnings, notices);
}

/** Version Resolution Engine: turns a family plus the user's per-family preference into a model. */
export function resolveFamily(
  registry: ModelRegistry,
  family: Family,
  settings: RouterSettings,
  strictModern: boolean,
  warnings: string[],
  notices: string[],
): Resolved {
  const pref = settings.families[family];
  const latest = registry.latest(family, settings.releaseChannel);

  let requestedId: string | undefined;
  if (pref.channel === "snapshot") requestedId = pref.snapshot;
  if (pref.channel === "custom") requestedId = pref.customModelId?.trim();
  if (!requestedId) return { model: latest };

  if (registry.isRetired(requestedId)) {
    warnings.push(LEGACY_MAPPED_WARNING);
    const mappedFamily = familyFromModelId(requestedId) ?? family;
    return { model: registry.latest(mappedFamily, settings.releaseChannel) };
  }

  const known = registry.find(requestedId);
  if (!known) return { passthroughId: requestedId };

  if (strictModern && generationOf(known.version) < generationOf(latest.version)) {
    notices.push(`$(arrow-up) Modern workspace: ${known.displayName} upgraded to ${latest.displayName}`);
    return { model: latest };
  }
  noteDeprecation(known, warnings);
  return { model: known };
}

function finish(
  registry: ModelRegistry,
  req: RouteRequest,
  resolved: Resolved,
  family: Family,
  source: RouteDecision["source"],
  prompt: string,
  classification: Classification | undefined,
  warnings: string[],
  notices: string[],
): RouteDecision {
  const provider = req.settings.provider;
  const effectiveFamily = resolved.model?.family ?? family;
  const info = registry.family(effectiveFamily);

  let providerModelId: string;
  if (resolved.model) {
    const id = registry.providerId(resolved.model, provider);
    if (!id) {
      throw new RoutingError(
        `${resolved.model.displayName} has no ${provider} model ID in the registry. Pick another version or set a custom model ID.`,
      );
    }
    providerModelId = id;
  } else {
    providerModelId = resolved.passthroughId!;
  }

  return {
    family: effectiveFamily,
    model: resolved.model,
    providerModelId,
    label: resolved.model?.displayName ?? providerModelId,
    icon: info.icon,
    source,
    prompt,
    classification,
    warnings,
    notices,
  };
}

function noteDeprecation(model: ModelEntry, warnings: string[]) {
  if (model.status === "deprecated") {
    warnings.push(`${model.displayName} is deprecated${model.retires ? ` and retires on ${model.retires}` : ""}.`);
  }
}
