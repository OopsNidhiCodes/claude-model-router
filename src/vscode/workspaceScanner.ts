import * as vscode from "vscode";
import { StrictModernThresholds } from "../core/types";
import { evaluateWorkspace, WorkspaceFiles, WorkspaceProfile } from "../core/workspaceConstraints";

const FILES: Record<keyof WorkspaceFiles, string> = {
  packageJson: "package.json",
  tsconfigJson: "tsconfig.json",
  requirementsTxt: "requirements.txt",
  pyprojectToml: "pyproject.toml",
  pythonVersion: ".python-version",
  goMod: "go.mod",
};

/** Scans workspace-root declaration files and rescans when any of them change. */
export class WorkspaceScanner implements vscode.Disposable {
  private profile: WorkspaceProfile = { strictModern: false, markers: [] };
  private watchers: vscode.FileSystemWatcher[] = [];
  private readonly folderListener: vscode.Disposable;

  constructor(private thresholds: () => StrictModernThresholds) {
    this.watchRoots();
    this.folderListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.watchRoots();
      void this.scan();
    });
  }

  // Only root-level declaration files matter, so don't watch nested ones (node_modules etc.).
  private watchRoots() {
    this.watchers.forEach((w) => w.dispose());
    const glob = `{${Object.values(FILES).join(",")}}`;
    this.watchers = (vscode.workspace.workspaceFolders ?? []).map((folder) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, glob));
      const rescan = () => void this.scan();
      watcher.onDidChange(rescan);
      watcher.onDidCreate(rescan);
      watcher.onDidDelete(rescan);
      return watcher;
    });
  }

  get current(): WorkspaceProfile {
    return this.profile;
  }

  async scan(): Promise<WorkspaceProfile> {
    const files: WorkspaceFiles = {};
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const [key, name] of Object.entries(FILES) as [keyof WorkspaceFiles, string][]) {
        if (files[key]) continue;
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, name));
          files[key] = new TextDecoder().decode(bytes);
        } catch {
          // File not present in this folder.
        }
      }
    }
    this.profile = evaluateWorkspace(files, this.thresholds());
    return this.profile;
  }

  dispose() {
    this.watchers.forEach((w) => w.dispose());
    this.folderListener.dispose();
  }
}
