import * as vscode from "vscode";
import { ModelRegistry } from "../core/registry";
import { route, RoutingError } from "../core/router";
import { Family, ProviderName, RouteDecision } from "../core/types";
import {
  createProvider,
  FallbackCandidate,
  fallbackServedBy,
  Message,
  MessageParam,
  ProviderOptions,
  streamWithFallback,
} from "../providers/provider";
import { ClassifierModel } from "../core/features";
import { loadClassifierModel, loadRegistry, maxTokens, readProviderOptions, readSettings } from "./config";
import { DecisionLog } from "./decisionLog";
import { RouterStatusBar } from "./statusBar";
import { WorkspaceScanner } from "./workspaceScanner";

export interface RoutedPrompt {
  prompt: string;
  contextBytes: number;
  inlineEdit?: boolean;
  /** Escalation floor; see RouteRequest.minFamily. */
  minFamily?: Family;
}

export interface SendOptions {
  system: string;
  messages: MessageParam[];
  signal?: AbortSignal;
  onText: (delta: string) => void;
}

/**
 * Tried in this order after the settings-chosen provider, for a 429/5xx that
 * survives the SDK's own retries. Only providers the registry has an id for
 * the model on are actually attempted.
 */
const PROVIDER_FALLBACK_ORDER: ProviderName[] = ["anthropic", "bedrock", "vertex"];

/** Ties the routing chain, the UI feedback layer and the network provider together. */
export class RouterService implements vscode.Disposable {
  private registry: ModelRegistry;
  private readonly model: ClassifierModel | undefined;
  readonly scanner: WorkspaceScanner;
  readonly statusBar = new RouterStatusBar();
  readonly log: DecisionLog;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.log = new DecisionLog(context);
    this.registry = loadRegistry(context.extensionPath);
    this.model = loadClassifierModel(context.extensionPath);
    this.scanner = new WorkspaceScanner(() => this.registry.data.strictModern);
    void this.scanner.scan();
    this.statusBar.showSettings(readSettings());
  }

  reloadRegistry() {
    this.registry = loadRegistry(this.context.extensionPath);
    void this.scanner.scan();
  }

  get models() {
    return this.registry.models();
  }

  /**
   * Runs the routing chain and flashes the result. Returns undefined (after
   * telling the user) when routing aborts, e.g. on an unknown /prefix.
   */
  decide(input: RoutedPrompt): RouteDecision | undefined {
    const settings = readSettings();
    try {
      const decision = route(this.registry, { ...input, settings, strictModern: this.scanner.current.strictModern, model: this.model });
      for (const warning of decision.warnings) void vscode.window.showWarningMessage(warning);
      this.statusBar.flash(decision);
      return decision;
    } catch (err) {
      if (!(err instanceof RoutingError)) throw err;
      void vscode.window.showErrorMessage(err.message);
      return undefined;
    }
  }

  /**
   * Streams one request. On a 429/5xx that outlasts the provider SDK's own
   * retries, falls back to the same model on another provider before giving
   * up; see `providerFallbackCandidates` and `streamWithFallback`. Reports
   * either kind of fallback (cross-provider, or the Claude API's own
   * server-side model fallback) in the status bar.
   */
  async send(decision: RouteDecision, opts: SendOptions): Promise<Message> {
    const settings = readSettings();
    const providerOptions = await readProviderOptions(this.context.secrets);
    const candidates = this.providerFallbackCandidates(decision, settings.provider, providerOptions);

    const { message, servedByProvider } = await streamWithFallback(
      candidates,
      {
        system: opts.system,
        messages: opts.messages,
        maxTokens: maxTokens(),
        serverFallback: decision.model?.serverFallback ?? false,
        signal: opts.signal,
      },
      opts.onText,
    );

    if (servedByProvider) {
      this.statusBar.flashProviderFallback(decision.label, settings.provider, servedByProvider);
    }
    const servedBy = fallbackServedBy(message, decision.providerModelId);
    if (servedBy) this.statusBar.flashFallback(decision.label, this.registry.find(servedBy)?.displayName ?? servedBy);
    return message;
  }

  /**
   * The primary provider first, then whichever others the registry has an id
   * for this model on, in `PROVIDER_FALLBACK_ORDER`. A custom/passthrough
   * model (no registry entry) has no known equivalent elsewhere, so it is the
   * only candidate.
   */
  private providerFallbackCandidates(decision: RouteDecision, primary: ProviderName, providerOptions: ProviderOptions): FallbackCandidate[] {
    const candidates: FallbackCandidate[] = [
      { provider: primary, client: createProvider(primary, providerOptions), model: decision.providerModelId },
    ];
    if (!decision.model) return candidates;

    for (const provider of PROVIDER_FALLBACK_ORDER) {
      if (provider === primary) continue;
      const model = this.registry.providerId(decision.model, provider);
      if (model) candidates.push({ provider, client: createProvider(provider, providerOptions), model });
    }
    return candidates;
  }

  dispose() {
    this.scanner.dispose();
    this.statusBar.dispose();
  }
}
