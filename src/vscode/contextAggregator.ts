import * as vscode from "vscode";

export interface EditorContext {
  /** Text block prepended to the user's prompt; empty when nothing is attached. */
  text: string;
  bytes: number;
  description: string;
}

const EMPTY: EditorContext = { text: "", bytes: 0, description: "no editor context" };

/** Attaches the active selection, or the whole active file when nothing is selected. */
export function gatherEditorContext(editor = vscode.window.activeTextEditor): EditorContext {
  if (!editor) return EMPTY;
  const doc = editor.document;
  const file = vscode.workspace.asRelativePath(doc.uri);
  const selected = !editor.selection.isEmpty;
  const content = selected ? doc.getText(editor.selection) : doc.getText();
  if (!content.trim()) return EMPTY;

  const range = selected ? ` lines="${editor.selection.start.line + 1}-${editor.selection.end.line + 1}"` : "";
  return {
    text: `<file path="${file}" language="${doc.languageId}"${range}>\n${content}\n</file>`,
    bytes: Buffer.byteLength(content, "utf8"),
    description: selected ? `selection in ${file}` : file,
  };
}

/** Context for an in-place edit: the selection to replace plus the whole file for reference. */
export function gatherEditContext(editor: vscode.TextEditor): EditorContext & { selection: string } {
  const doc = editor.document;
  const file = vscode.workspace.asRelativePath(doc.uri);
  const selection = doc.getText(editor.selection);
  const full = doc.getText();
  const text = [
    `<file path="${file}" language="${doc.languageId}">\n${full}\n</file>`,
    `<selection lines="${editor.selection.start.line + 1}-${editor.selection.end.line + 1}">\n${selection}\n</selection>`,
  ].join("\n\n");
  return { text, selection, bytes: Buffer.byteLength(selection, "utf8"), description: `selection in ${file}` };
}
