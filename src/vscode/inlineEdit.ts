import * as vscode from "vscode";
import { stripFences } from "../core/text";
import { describeError, messageText } from "../providers/provider";
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
  const decision = service.decide({ prompt: instruction, contextBytes: context.bytes, inlineEdit: true });
  if (!decision) return;

  const doc = editor.document;
  const selection = editor.selection;
  const versionAtStart = doc.version;

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `${decision.label}: editing selection`, cancellable: true },
    async (_progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      try {
        return await service.send(decision, {
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: `${context.text}\n\n<instruction>\n${decision.prompt}\n</instruction>` }],
          signal: abort.signal,
          onText: () => undefined,
        });
      } catch (err) {
        void vscode.window.showErrorMessage(`Claude Router: ${describeError(err)}`);
        return undefined;
      }
    },
  );
  if (!result) return;

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
