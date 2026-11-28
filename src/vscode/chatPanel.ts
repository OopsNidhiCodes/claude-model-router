import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { Escalation } from "../core/decisionLog";
import { DispatchCapState, INITIAL_DISPATCH_CAP_STATE, trackDispatch } from "../core/dispatchCap";
import { isEscalationRequest, nextFamily, systemPromptFor } from "../core/escalation";
import { Family, RouteDecision } from "../core/types";
import { assistantTurn, describeError, MessageParam, messageText } from "../providers/provider";
import { dispatchCapMaxConsecutiveTurns, maxAutoEscalations } from "./config";
import { gatherEditorContext } from "./contextAggregator";
import { RouterService } from "./routerService";

const SYSTEM_PROMPT =
  "You are a coding assistant inside VS Code. The user's message may start with a <file> block holding the active file or selection; " +
  "use it as context. Answer concisely and use Markdown code blocks for code.";

type FromWebview = { type: "send"; text: string; includeContext: boolean } | { type: "stop" } | { type: "clear" } | { type: "escalate" };

/** What is needed to re-run a turn on a higher tier. */
interface Turn {
  prompt: string;
  contextBytes: number;
  user: MessageParam;
  decision: RouteDecision;
  /** First decision of this turn, kept for the decision log. */
  first: RouteDecision;
  escalations: Escalation[];
}

/** Sidebar-style chat channel in its own webview panel. One conversation per panel. */
export class ChatPanel implements vscode.Disposable {
  private static current: ChatPanel | undefined;

  static show(service: RouterService) {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal();
      return;
    }
    ChatPanel.current = new ChatPanel(service);
  }

  private readonly panel: vscode.WebviewPanel;
  private history: MessageParam[] = [];
  private pending: AbortController | undefined;
  /** Escalation floor for this conversation; once raised it stays raised ("sticky upward"). */
  private minFamily: Family | undefined;
  /** The last completed exchange, so the Escalate button can redo it. */
  private last: Turn | undefined;
  /** Consecutive same-family replies, for the dispatch cap (see core/dispatchCap.ts). */
  private dispatchCap: DispatchCapState = INITIAL_DISPATCH_CAP_STATE;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(private readonly service: RouterService) {
    this.panel = vscode.window.createWebviewPanel("claudeRouter.chat", "Claude Router", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.webview.html = html(randomBytes(16).toString("base64"), this.panel.webview.cspSource);
    this.panel.webview.onDidReceiveMessage((msg: FromWebview) => void this.handle(msg), undefined, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  private post(msg: Record<string, unknown>) {
    void this.panel.webview.postMessage(msg);
  }

  private async handle(msg: FromWebview) {
    if (msg.type === "stop") return this.pending?.abort();
    if (msg.type === "clear") {
      this.history = [];
      this.minFamily = undefined;
      this.last = undefined;
      this.dispatchCap = INITIAL_DISPATCH_CAP_STATE;
      return;
    }
    if (this.pending) return;

    if (msg.type === "escalate") return this.escalateLast();
    if (!msg.text.trim()) return;

    const context = msg.includeContext ? gatherEditorContext() : { text: "", bytes: 0, description: "" };
    const decision = this.service.decide({ prompt: msg.text, contextBytes: context.bytes, minFamily: this.minFamily });
    if (!decision) {
      this.post({ type: "rejected" });
      return;
    }
    const content = context.text ? `${context.text}\n\n${decision.prompt}` : decision.prompt;
    await this.run(
      { prompt: msg.text, contextBytes: context.bytes, user: { role: "user", content }, decision, first: decision, escalations: [] },
      context.description,
    );
  }

  /** User pressed Escalate: forget the last exchange and redo it one tier up. */
  private async escalateLast() {
    const last = this.last;
    const to = last && nextFamily(last.decision.family);
    if (!last || !to) return;
    this.history.splice(-2, 2);
    this.minFamily = to;
    const decision = this.service.decide({ prompt: last.prompt, contextBytes: last.contextBytes, minFamily: to });
    if (!decision) {
      this.post({ type: "rejected" });
      return;
    }
    await this.run({ ...last, decision, first: decision, escalations: [{ from: last.decision.family, to, by: "user" }] }, "");
  }

  /** Streams one turn. If the model asks to escalate, retries on the next tier until the top. */
  private async run(turn: Turn, contextDescription: string): Promise<void> {
    this.post({ type: "start", label: turn.decision.label, modelId: turn.decision.providerModelId, contextDescription, canEscalate: false });
    this.pending = new AbortController();
    try {
      const message = await this.service.send(turn.decision, {
        system: systemPromptFor(SYSTEM_PROMPT, turn.decision.family),
        messages: [...this.history, turn.user],
        signal: this.pending.signal,
        onText: (delta) => this.post({ type: "delta", text: delta }),
      });
      if (message.stop_reason === "refusal") {
        // A refused turn is not kept, so the next request starts from a clean history.
        this.post({ type: "end", note: "The model declined this request." });
        void this.log(turn, { stopReason: "refusal" });
        return;
      }

      const to = nextFamily(turn.decision.family);
      const autoUsed = turn.escalations.filter((e) => e.by === "model").length;
      if (isEscalationRequest(messageText(message)) && to && autoUsed < maxAutoEscalations()) {
        this.minFamily = to;
        const decision = this.service.decide({ prompt: turn.prompt, contextBytes: turn.contextBytes, minFamily: to });
        if (decision) {
          this.post({ type: "escalating", note: `${turn.decision.label} asked to escalate. Retrying with ${decision.label}.` });
          this.pending = undefined;
          return this.run({ ...turn, decision, escalations: [...turn.escalations, { from: turn.decision.family, to, by: "model" }] }, contextDescription);
        }
      }

      this.history.push(turn.user, assistantTurn(message));
      this.last = turn;
      const servedBy = message.model !== turn.decision.providerModelId ? message.model : undefined;
      const note = message.stop_reason === "max_tokens" ? "Response truncated at max_tokens." : undefined;

      const dispatch = trackDispatch(this.dispatchCap, turn.decision.family, dispatchCapMaxConsecutiveTurns());
      this.dispatchCap = dispatch.state;
      let floorNotice: string | undefined;
      if (dispatch.raiseTo) {
        this.minFamily = dispatch.raiseTo;
        floorNotice = `${turn.decision.label} has answered ${dispatchCapMaxConsecutiveTurns()} times in a row without escalating — switching to ${displayName(dispatch.raiseTo)}.`;
      }

      this.post({ type: "end", note, floorNotice, servedBy, canEscalate: to !== undefined });
      void this.log(turn, { stopReason: message.stop_reason ?? undefined, servedBy });
    } catch (err) {
      this.post({ type: "error", text: describeError(err) });
      void this.log(turn, { error: describeError(err) });
    } finally {
      this.pending = undefined;
    }
  }

  private log(turn: Turn, outcome: { stopReason?: string; servedBy?: string; error?: string }) {
    return this.service.log.record({
      surface: "chat",
      prompt: turn.prompt,
      contextBytes: turn.contextBytes,
      first: turn.first,
      final: turn.decision,
      escalations: turn.escalations,
      ...outcome,
    });
  }

  dispose() {
    ChatPanel.current = undefined;
    this.pending?.abort();
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }
}

function displayName(family: Family): string {
  return family[0].toUpperCase() + family.slice(1);
}

function html(nonce: string, cspSource: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 12px; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; margin: 0; }
  #log { flex: 1; overflow-y: auto; padding: 12px 0; }
  .turn { margin-bottom: 14px; }
  .role { font-size: 0.85em; opacity: 0.75; margin-bottom: 4px; }
  .model { font-family: var(--vscode-editor-font-family); background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 3px; padding: 0 5px; }
  .body { white-space: pre-wrap; word-wrap: break-word; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  .user .body { background: var(--vscode-input-background); padding: 6px 8px; border-radius: 4px; }
  .note { font-size: 0.85em; color: var(--vscode-editorWarning-foreground); margin-top: 4px; }
  .error { color: var(--vscode-errorForeground); }
  form { border-top: 1px solid var(--vscode-panel-border); padding: 8px 0 12px; }
  textarea { width: 100%; box-sizing: border-box; min-height: 64px; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); font-family: inherit; padding: 6px; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
  .row label { flex: 1; font-size: 0.9em; opacity: 0.85; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity: 0.5; cursor: default; }
  .hint { font-size: 0.8em; opacity: 0.6; margin-top: 4px; }
</style>
</head>
<body>
<div id="log"></div>
<form id="form">
  <textarea id="input" placeholder="Ask Claude. Start with /haiku, /sonnet, /opus, /fable or e.g. /sonnet-5.5 to choose the model yourself."></textarea>
  <div class="row">
    <label><input type="checkbox" id="ctx" checked> Include active file / selection</label>
    <button type="button" class="secondary" id="clear">New chat</button>
    <button type="button" class="secondary" id="stop" disabled>Stop</button>
    <button type="button" class="secondary" id="escalate" disabled title="Redo the last answer with the next model tier up">Escalate</button>
    <button type="submit" id="send">Send</button>
  </div>
  <div class="hint">Enter to send, Shift+Enter for a new line.</div>
</form>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById("log");
  const input = document.getElementById("input");
  const send = document.getElementById("send");
  const stop = document.getElementById("stop");
  const escalate = document.getElementById("escalate");
  let current = null;
  let lastUserTurn = null;

  function turn(cls, roleHtml) {
    const el = document.createElement("div");
    el.className = "turn " + cls;
    const role = document.createElement("div");
    role.className = "role";
    role.append(...roleHtml);
    const body = document.createElement("div");
    body.className = "body";
    el.append(role, body);
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return { el, body };
  }
  function busy(on) { send.disabled = on; stop.disabled = !on; if (on) escalate.disabled = true; }
  function note(el, text, cls) {
    const n = document.createElement("div");
    n.className = "note" + (cls ? " " + cls : "");
    n.textContent = text;
    el.append(n);
  }

  document.getElementById("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim() || send.disabled) return;
    lastUserTurn = turn("user", ["You"]);
    lastUserTurn.body.textContent = text;
    input.value = "";
    busy(true);
    vscode.postMessage({ type: "send", text, includeContext: document.getElementById("ctx").checked });
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); document.getElementById("form").requestSubmit(); }
  });
  stop.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  escalate.addEventListener("click", () => { busy(true); vscode.postMessage({ type: "escalate" }); });
  document.getElementById("clear").addEventListener("click", () => {
    log.textContent = "";
    escalate.disabled = true;
    vscode.postMessage({ type: "clear" });
  });

  window.addEventListener("message", ({ data }) => {
    switch (data.type) {
      case "rejected":
        if (lastUserTurn) note(lastUserTurn.el, "Not sent: routing was rejected.", "error");
        busy(false);
        break;
      case "start": {
        const badge = document.createElement("span");
        badge.className = "model";
        badge.textContent = data.label;
        badge.title = data.modelId + (data.contextDescription ? " · context: " + data.contextDescription : "");
        current = turn("assistant", [badge]);
        break;
      }
      case "delta":
        if (current) { current.body.textContent += data.text; log.scrollTop = log.scrollHeight; }
        break;
      case "escalating":
        if (current) { current.body.textContent = ""; note(current.el, data.note); }
        current = null;
        break;
      case "end":
        if (current) {
          if (data.servedBy) note(current.el, "Answered by " + data.servedBy + " (fallback).");
          if (data.note) note(current.el, data.note);
          if (data.floorNotice) note(current.el, data.floorNotice);
        }
        current = null;
        busy(false);
        escalate.disabled = !data.canEscalate;
        break;
      case "error":
        note((current || lastUserTurn).el, data.text, "error");
        current = null;
        busy(false);
        break;
    }
  });
</script>
</body>
</html>`;
}
