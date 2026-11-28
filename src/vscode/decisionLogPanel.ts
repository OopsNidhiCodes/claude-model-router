import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { DecisionLogEntry } from "../core/decisionLog";
import { DecisionLog } from "./decisionLog";

type FromWebview = { type: "refresh" } | { type: "clear" };

/**
 * Read-only table view of the decision log, so checking the classifier against
 * real use doesn't mean opening raw JSONL. "Claude Router: Open Decision Log"
 * (the raw file) still exists alongside this for scripting or export.
 */
export class DecisionLogPanel implements vscode.Disposable {
  private static current: DecisionLogPanel | undefined;

  static show(log: DecisionLog) {
    if (DecisionLogPanel.current) {
      DecisionLogPanel.current.panel.reveal();
      void DecisionLogPanel.current.refresh();
      return;
    }
    DecisionLogPanel.current = new DecisionLogPanel(log);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(private readonly log: DecisionLog) {
    this.panel = vscode.window.createWebviewPanel("claudeRouter.decisionLog", "Claude Router: Decision Log", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.webview.html = html(randomBytes(16).toString("base64"), this.panel.webview.cspSource);
    this.panel.webview.onDidReceiveMessage((msg: FromWebview) => void this.handle(msg), undefined, this.disposables);
    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) void this.refresh();
    }, undefined, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    void this.refresh();
  }

  private async handle(msg: FromWebview) {
    if (msg.type === "refresh") return this.refresh();
    if (msg.type === "clear") {
      await this.log.clear();
      return this.refresh();
    }
  }

  private async refresh() {
    const entries = await this.log.readEntries();
    void this.panel.webview.postMessage({ type: "entries", entries, enabled: this.log.isEnabled() });
  }

  dispose() {
    DecisionLogPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }
}

function html(nonce: string, cspSource: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 12px 12px; margin: 0; }
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 10px 0; position: sticky; top: 0; background: var(--vscode-editor-background); }
  .toolbar .count { flex: 1; opacity: 0.75; font-size: 0.9em; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 12px; cursor: pointer; }
  button.danger:hover { background: var(--vscode-errorForeground); color: white; }
  .empty, .disabled { opacity: 0.7; padding: 24px 4px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  th { position: sticky; top: 41px; background: var(--vscode-editor-background); opacity: 0.8; font-weight: 600; }
  td.prompt { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family); }
  td.muted { opacity: 0.6; font-style: italic; }
  .badge { font-family: var(--vscode-editor-font-family); background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 3px; padding: 0 5px; white-space: nowrap; }
  .arrow { opacity: 0.7; padding: 0 3px; }
  .error-row td { color: var(--vscode-errorForeground); }
  .escalated { color: var(--vscode-editorWarning-foreground); }
</style>
</head>
<body>
<div class="toolbar">
  <span class="count" id="count"></span>
  <button id="refresh">Refresh</button>
  <button id="clear" class="danger">Clear</button>
</div>
<div id="content"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const content = document.getElementById("content");
  const count = document.getElementById("count");

  document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  document.getElementById("clear").addEventListener("click", () => vscode.postMessage({ type: "clear" }));

  function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function time(ts) { try { return new Date(ts).toLocaleString(); } catch { return ts; } }

  function scoresTooltip(entry) {
    const parts = [];
    if (entry.tier) parts.push("tier: " + entry.tier);
    if (entry.scores) parts.push("scores: " + Object.entries(entry.scores).map(([k, v]) => k + "=" + v).join(" "));
    if (entry.reasons && entry.reasons.length) parts.push("reasons: " + entry.reasons.join(", "));
    return parts.join("\\n");
  }

  function row(entry) {
    const tr = document.createElement("tr");
    if (entry.error) tr.className = "error-row";

    const td = (cls) => { const el = document.createElement("td"); if (cls) el.className = cls; tr.appendChild(el); return el; };

    td().textContent = time(entry.ts);
    td().textContent = entry.surface;

    const promptCell = td("prompt");
    if (entry.prompt !== undefined) {
      promptCell.textContent = entry.prompt.replace(/\\s+/g, " ");
      promptCell.title = entry.prompt;
    } else {
      promptCell.textContent = "(not logged, " + entry.promptChars + " chars)";
      promptCell.classList.add("muted");
    }

    const tierCell = td();
    tierCell.textContent = entry.tier ?? "–";
    tierCell.title = scoresTooltip(entry);

    const decidedCell = td();
    const decidedBadge = document.createElement("span");
    decidedBadge.className = "badge";
    decidedBadge.textContent = entry.decided.family;
    decidedCell.append(decidedBadge, " (" + entry.decided.source + ")");

    const servedCell = td();
    if (entry.served.family !== entry.decided.family) {
      servedCell.className = "escalated";
      const arrow = document.createElement("span");
      arrow.className = "arrow";
      arrow.textContent = "→";
      const servedBadge = document.createElement("span");
      servedBadge.className = "badge";
      servedBadge.textContent = entry.served.family;
      servedCell.append(arrow, servedBadge);
    } else {
      servedCell.textContent = "—";
      servedCell.className = "muted";
    }

    td().textContent = entry.escalations.length
      ? entry.escalations.length + " (" + entry.escalations.map((e) => e.by).join(", ") + ")"
      : "";

    td().textContent = entry.error ? "error: " + entry.error : (entry.stopReason ?? "");

    return tr;
  }

  window.addEventListener("message", ({ data }) => {
    if (data.type !== "entries") return;
    content.textContent = "";

    if (!data.enabled) {
      count.textContent = "";
      const div = document.createElement("div");
      div.className = "disabled";
      div.textContent = 'Decision log is off. Enable "claudeRouter.decisionLog.enabled" in settings to start recording.';
      content.append(div);
      return;
    }

    count.textContent = data.entries.length + " decision" + (data.entries.length === 1 ? "" : "s") + " (most recent first)";

    if (data.entries.length === 0) {
      const div = document.createElement("div");
      div.className = "empty";
      div.textContent = "No decisions logged yet. Send a message in the chat or run Edit Selection.";
      content.append(div);
      return;
    }

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>Time</th><th>Surface</th><th>Prompt</th><th>Tier</th><th>Decided</th><th>Served</th><th>Escalated</th><th>Result</th></tr>";
    const tbody = document.createElement("tbody");
    for (const entry of data.entries) tbody.append(row(entry));
    table.append(thead, tbody);
    content.append(table);
  });

  vscode.postMessage({ type: "refresh" });
</script>
</body>
</html>`;
}
