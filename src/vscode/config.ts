import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ModelRegistry, validateRegistry } from "../core/registry";
import { FAMILIES, Family, FamilyPreference, ProviderName, ReleaseChannel, RouterSettings } from "../core/types";
import { ProviderOptions } from "../providers/provider";

export const SECTION = "claudeRouter";
export const API_KEY_SECRET = "claudeRouter.anthropicApiKey";

export function readSettings(): RouterSettings {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const families = {} as Record<Family, FamilyPreference>;
  for (const f of FAMILIES) {
    families[f] = {
      channel: cfg.get(`${f}.channel`, "latest"),
      snapshot: cfg.get<string>(`${f}.snapshot`),
      customModelId: cfg.get<string>(`${f}.customModelId`),
    };
  }
  return {
    pinnedFamily: cfg.get<Family | "auto">("pinnedFamily", "auto"),
    releaseChannel: cfg.get<ReleaseChannel>("releaseChannel", "stable"),
    provider: cfg.get<ProviderName>("provider", "anthropic"),
    families,
  };
}

export async function readProviderOptions(secrets: vscode.SecretStorage): Promise<ProviderOptions> {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    anthropicApiKey: await secrets.get(API_KEY_SECRET),
    bedrockRegion: cfg.get<string>("bedrock.region"),
    vertexProjectId: cfg.get<string>("vertex.projectId"),
    vertexRegion: cfg.get<string>("vertex.region"),
  };
}

export function maxTokens(): number {
  return vscode.workspace.getConfiguration(SECTION).get<number>("maxTokens", 64000);
}

/**
 * Loads the registry from `claudeRouter.registryPath` when set, otherwise the
 * bundled copy. An invalid override falls back to the bundled registry.
 */
export function loadRegistry(extensionPath: string): ModelRegistry {
  const bundled = path.join(extensionPath, "resources", "models-registry.json");
  const override = vscode.workspace.getConfiguration(SECTION).get<string>("registryPath")?.trim();
  if (override) {
    try {
      return new ModelRegistry(validateRegistry(JSON.parse(readFileSync(override, "utf8"))));
    } catch (err) {
      void vscode.window.showErrorMessage(`Claude Router: could not load registry at ${override} (${String(err)}). Using the bundled registry.`);
    }
  }
  return new ModelRegistry(validateRegistry(JSON.parse(readFileSync(bundled, "utf8"))));
}
