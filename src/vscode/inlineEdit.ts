import * as vscode from "vscode";
import { Escalation } from "../core/decisionLog";
import { isEscalationRequest, nextFamily, systemPromptFor } from "../core/escalation";
import { stripFences } from "../core/text";
import { Family, RouteDecision } from "../core/types";
import { describeError, messageText } from "../providers/provider";
import { maxAutoEscalations } from "./config";
import { gatherEditContext } from "./contextAggregator";
import { RouterService } from "./routerService";

const SYSTEM_PROMPT =
  "You edit code in place inside VS Code. You receive the whole file for reference and the <selection> to rewrite. " +
  "Reply with only the replacement text for the selection: no explanation, no Markdown code fences, " +
  "and keep the selection's indentation style.";

/** Replaces the active selection with the model's rewrite in one undoable edit. */
export async function editSelection(service: RouterService) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage("Claude Router: select the code to edit first.");
    return;
  }

  const instruction = await vscode.window.showInputBox({
    title: "Claude Router: Edit Selection",
    prompt: "Describe the change. Start with /haiku, /sonnet, /opus or /fable to choose the model.",
    ignoreFocusOut: true,
  });
  if (!instruction?.trim()) return;

  const context = gatherEditContext(editor);
  const doc = editor.document;
  const selection = editor.selection;
  const versionAtStart = doc.version;

  // Escalation loop: a model that replies ESCALATE hands the edit to the next tier up.
  let minFamily: Family | undefined;
  let decision: RouteDecision | undefined;
  let first: RouteDecision | undefined;
  const escalations: Escalation[] = [];
  let result: Awaited<ReturnType<typeof service.send>> | undefined;
  const log = (outcome: { stopReason?: string; error?: string }) =>
    first && decision && service.log.record({ surface: "inlineEdit", prompt: instruction, contextBytes: context.bytes, first, final: decision, escalations, ...outcome });
  for (;;) {
    decision = service.decide({ prompt: instruction, contextBytes: context.bytes, inlineEdit: true, minFamily });
    if (!decision) return;
    first ??= decision;
    const current = decision;

    result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `${current.label}: editing selection`, cancellable: true },
      async (_progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        try {
          return await service.send(current, {
            system: systemPromptFor(SYSTEM_PROMPT, current.family),
            messages: [{ role: "user", content: `${context.text}\n\n<instruction>\n${current.prompt}\n</instruction>` }],
            signal: abort.signal,
            onText: () => undefined,
          });
        } catch (err) {
          void vscode.window.showErrorMessage(`Claude Router: ${describeError(err)}`);
          void log({ error: describeError(err) });
          return undefined;
        }
      },
    );
    if (!result) return;

    const to = nextFamily(current.family);
    if (!isEscalationRequest(messageText(result)) || !to || escalations.length >= maxAutoEscalations()) break;
    minFamily = to;
    escalations.push({ from: current.family, to, by: "model" });
    void vscode.window.showInformationMessage(`Claude Router: ${current.label} asked to escalate; retrying one tier up.`);
  }
  void log({ stopReason: result.stop_reason ?? undefined });

  if (result.stop_reason === "refusal") {
    void vscode.window.showWarningMessage("Claude Router: the model declined this edit.");
    return;
  }
  if (result.stop_reason === "max_tokens") {
    void vscode.window.showWarningMessage("Claude Router: the reply hit max_tokens, so the edit was not applied.");
    return;
  }
  if (doc.version !== versionAtStart) {
    void vscode.window.showWarningMessage("Claude Router: the file changed while the edit was running, so it was not applied.");
    return;
  }

  const replacement = stripFences(messageText(result));
  const applied = await editor.edit((builder) => builder.replace(selection, replacement));
  if (!applied) void vscode.window.showErrorMessage("Claude Router: could not apply the edit.");
}
