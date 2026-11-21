import { appendFile, mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildEntry, TurnOutcome } from "../core/decisionLog";
import { SECTION } from "./config";

/**
 * Opt-in, local-only log of routing decisions (one JSON object per line).
 * Lives in the extension's global storage folder and is never sent anywhere.
 */
export class DecisionLog {
  readonly file: string;

  constructor(context: vscode.ExtensionContext) {
    this.file = path.join(context.globalStorageUri.fsPath, "decisions.jsonl");
  }

  private get config() {
    const cfg = vscode.workspace.getConfiguration(`${SECTION}.decisionLog`);
    return { enabled: cfg.get<boolean>("enabled", false), includePrompt: cfg.get<boolean>("includePrompt", true) };
  }

  /** Appends one turn. Logging failures are reported once in the status area, never thrown. */
  async record(outcome: TurnOutcome): Promise<void> {
    const { enabled, includePrompt } = this.config;
    if (!enabled) return;
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      await appendFile(this.file, JSON.stringify(buildEntry(outcome, includePrompt)) + "\n", "utf8");
    } catch (err) {
      void vscode.window.setStatusBarMessage(`Claude Router: could not write decision log (${String(err)})`, 5000);
    }
  }

  async open(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, "", "utf8"); // ensure it exists
    await vscode.window.showTextDocument(vscode.Uri.file(this.file), { preview: false });
  }

  async clear(): Promise<void> {
    const pick = await vscode.window.showWarningMessage("Claude Router: delete all logged decisions?", { modal: true }, "Delete");
    if (pick !== "Delete") return;
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, "", "utf8");
    void vscode.window.showInformationMessage("Claude Router: decision log cleared.");
  }
}
