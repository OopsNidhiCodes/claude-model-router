import * as vscode from "vscode";
import { ModelRegistry } from "../core/registry";
import { route, RoutingError } from "../core/router";
import { Family, RouteDecision } from "../core/types";
import { createProvider, fallbackServedBy, Message, MessageParam } from "../providers/provider";
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

  /** Streams one request to the configured provider and reports fallbacks in the status bar. */
  async send(decision: RouteDecision, opts: SendOptions): Promise<Message> {
    const settings = readSettings();
    const provider = createProvider(settings.provider, await readProviderOptions(this.context.secrets));
    const message = await provider.stream(
      {
        model: decision.providerModelId,
        system: opts.system,
        messages: opts.messages,
        maxTokens: maxTokens(),
        serverFallback: decision.model?.serverFallback ?? false,
        signal: opts.signal,
      },
      opts.onText,
    );
    const servedBy = fallbackServedBy(message, decision.providerModelId);
    if (servedBy) this.statusBar.flashFallback(decision.label, this.registry.find(servedBy)?.displayName ?? servedBy);
    return message;
  }

  dispose() {
    this.scanner.dispose();
    this.statusBar.dispose();
  }
}
