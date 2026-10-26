import { StrictModernThresholds } from "./types";
import { meetsMinimum } from "./version";

/** Raw contents of the workspace-root declaration files that were found. */
export interface WorkspaceFiles {
  packageJson?: string;
  tsconfigJson?: string;
  requirementsTxt?: string;
  pyprojectToml?: string;
  pythonVersion?: string;
  goMod?: string;
}

export interface WorkspaceProfile {
  strictModern: boolean;
  markers: string[];
}

export function evaluateWorkspace(files: WorkspaceFiles, thresholds: StrictModernThresholds): WorkspaceProfile {
  const markers = [
    ...checkPackageJson(files.packageJson, thresholds.npm),
    ...checkTsconfig(files.tsconfigJson, thresholds.tsconfigTarget),
    ...checkPython(files, thresholds),
    ...checkGoMod(files.goMod, thresholds.go),
  ];
  return { strictModern: markers.length > 0, markers };
}

function checkPackageJson(text: string | undefined, minimums: Record<string, string>): string[] {
  if (!text) return [];
  let pkg: Record<string, Record<string, string> | undefined>;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  const deps = { ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.dependencies };
  return Object.entries(minimums)
    .filter(([name, min]) => typeof deps[name] === "string" && meetsMinimum(deps[name], min))
    .map(([name]) => `${name}@${deps[name]}`);
}

function checkTsconfig(text: string | undefined, minimumTarget: string): string[] {
  if (!text) return [];
  // tsconfig allows comments, so match the field instead of parsing JSON.
  const target = /"target"\s*:\s*"([^"]+)"/i.exec(text)?.[1];
  if (!target) return [];
  const modern = /^esnext$/i.test(target) || meetsMinimum(target, minimumTarget);
  return modern ? [`tsconfig target ${target}`] : [];
}

function checkPython(files: WorkspaceFiles, thresholds: StrictModernThresholds): string[] {
  const markers: string[] = [];
  const declared =
    files.pythonVersion?.trim() ||
    /requires-python\s*=\s*["']([^"']+)["']/.exec(files.pyprojectToml ?? "")?.[1];
  if (declared && meetsMinimum(declared, thresholds.python)) markers.push(`python ${declared}`);

  const requirementSources = [files.requirementsTxt ?? "", files.pyprojectToml ?? ""].join("\n");
  for (const [name, min] of Object.entries(thresholds.pythonPackages)) {
    const re = new RegExp(`(?:^|["'\\s])${escapeRegExp(name)}\\s*(?:\\[[^\\]]*\\])?\\s*(==|>=|~=)\\s*([\\d.]+)`, "im");
    const version = re.exec(requirementSources)?.[2];
    if (version && meetsMinimum(version, min)) markers.push(`${name} ${version}`);
  }
  return markers;
}

function checkGoMod(text: string | undefined, minimum: string): string[] {
  const version = /^go\s+([\d.]+)/m.exec(text ?? "")?.[1];
  return version && meetsMinimum(version, minimum) ? [`go ${version}`] : [];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
