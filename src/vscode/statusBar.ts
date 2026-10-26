import * as vscode from "vscode";
import { RouteDecision, RouterSettings } from "../core/types";

const FLASH_MS = 4000;

/** UI Feedback Layer: shows the exact model version each request resolved to. */
export class RouterStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private resting = "$(hubot) Claude Router";
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    this.item.command = "claudeRouter.pickFamily";
    this.item.tooltip = "Claude Router: click to pin a model family";
    this.item.text = this.resting;
    this.item.show();
  }

  /** Resting text when idle: the pin, if any. */
  showSettings(settings: RouterSettings) {
    this.resting = settings.pinnedFamily === "auto" ? "$(hubot) Claude Router: auto" : `$(pin) Claude Router: ${settings.pinnedFamily}`;
    if (!this.timer) this.item.text = this.resting;
  }

  /** Flashes the decision, leading with any notice, then keeps the model label until the next request. */
  flash(decision: RouteDecision) {
    const label = `$(${decision.icon}) ${decision.label}`;
    const notice = decision.notices[0];
    this.item.text = notice ?? label;
    this.item.backgroundColor = notice ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    this.item.tooltip = tooltip(decision);
    this.setTimer(() => {
      this.item.text = label;
      this.item.backgroundColor = undefined;
    });
  }

  /** Shown when a server-side fallback served the request with another model. */
  flashFallback(fromLabel: string, toLabel: string) {
    this.item.text = `$(arrow-swap) ${fromLabel} → ${toLabel}`;
    this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    this.item.tooltip = `${fromLabel} declined the request; ${toLabel} answered it (server-side fallback).`;
    this.setTimer(() => {
      this.item.text = `$(arrow-swap) ${toLabel}`;
      this.item.backgroundColor = undefined;
    });
  }

  private setTimer(after: () => void) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      after();
    }, FLASH_MS);
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.item.dispose();
  }
}

function tooltip(d: RouteDecision): vscode.MarkdownString {
  const lines = [
    `**${d.label}** — \`${d.providerModelId}\``,
    `Decided by: ${d.source}`,
    ...(d.classification ? [`Signals: ${d.classification.reasons.join(", ")}`] : []),
    ...d.notices,
    ...d.warnings,
    "",
    "Click to pin a model family",
  ];
  const md = new vscode.MarkdownString(lines.join("\n\n"));
  md.supportThemeIcons = true;
  return md;
}
