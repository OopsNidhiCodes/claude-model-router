import * as vscode from "vscode";
import { FAMILIES } from "./core/types";
import { ChatPanel } from "./vscode/chatPanel";
import { API_KEY_SECRET, readSettings, SECTION } from "./vscode/config";
import { editSelection } from "./vscode/inlineEdit";
import { RouterService } from "./vscode/routerService";

export function activate(context: vscode.ExtensionContext) {
  const service = new RouterService(context);
  context.subscriptions.push(service);

  const command = (id: string, fn: () => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  command("claudeRouter.openChat", () => ChatPanel.show(service));
  command("claudeRouter.editSelection", () => editSelection(service));

  command("claudeRouter.pickFamily", async () => {
    const current = readSettings().pinnedFamily;
    const items = (["auto", ...FAMILIES] as const).map((f) => ({
      label: f === "auto" ? "Auto (local classifier)" : f[0].toUpperCase() + f.slice(1),
      description: f === current ? "current" : undefined,
      value: f,
    }));
    const pick = await vscode.window.showQuickPick(items, { title: "Claude Router: pin a model family" });
    if (pick) await vscode.workspace.getConfiguration(SECTION).update("pinnedFamily", pick.value, vscode.ConfigurationTarget.Global);
  });

  command("claudeRouter.setApiKey", async () => {
    const key = await vscode.window.showInputBox({ title: "Anthropic API key", password: true, ignoreFocusOut: true, placeHolder: "sk-ant-..." });
    if (!key?.trim()) return;
    await context.secrets.store(API_KEY_SECRET, key.trim());
    void vscode.window.showInformationMessage("Claude Router: API key saved to SecretStorage.");
  });

  command("claudeRouter.clearApiKey", async () => {
    await context.secrets.delete(API_KEY_SECRET);
    void vscode.window.showInformationMessage("Claude Router: API key removed.");
  });

  command("claudeRouter.rescanWorkspace", async () => {
    const profile = await service.scanner.scan();
    void vscode.window.showInformationMessage(
      profile.strictModern
        ? `Claude Router: strict-modern workspace (${profile.markers.join(", ")}). Legacy-generation pins upgrade to the current version.`
        : "Claude Router: no strict-modern markers found.",
    );
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(SECTION)) return;
      if (e.affectsConfiguration(`${SECTION}.registryPath`)) service.reloadRegistry();
      service.statusBar.showSettings(readSettings());
    }),
  );
}

export function deactivate() {}
