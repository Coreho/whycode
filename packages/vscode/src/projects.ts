// Turns the files and folders a command was given into the files WhyCode may
// read, project by project. A project root is found the way the CLI finds it
// when run in the workspace folder: the git root, else the nearest folder
// with a .whycoderc.json. Collection applies the privacy rules (gitignored
// and secret files are never read); files with unsaved edits are skipped
// too, because WhyCode works on what is on disk.
import { dirname, resolve } from "node:path";
import type {
  CollectedFile,
  LanguageAdapter,
  WhycodeConfig,
} from "@whycode/core";
import { collectFiles, findProjectRoot, loadConfig } from "@whycode/core";
import * as vscode from "vscode";
import type { Skip } from "./report.js";
import type { ProviderSetting } from "./settings.js";
import { readSettings } from "./settings.js";

export interface Project {
  rootDir: string;
  /** Always safe mode: the editor never offers refactor mode. */
  config: WhycodeConfig;
  provider: ProviderSetting;
  files: CollectedFile[];
}

export interface PreparedRun {
  projects: Project[];
  skipped: Skip[];
  /** Things worth telling the user before processing starts. */
  notes: string[];
}

export const UNSAVED_REASON =
  "has unsaved changes; save it first, because WhyCode works on the file on disk";

export async function prepareRun(
  paths: readonly string[],
  adapters: readonly LanguageAdapter[],
): Promise<PreparedRun> {
  const run: PreparedRun = { projects: [], skipped: [], notes: [] };
  for (const [startDir, group] of groupByStartFolder(paths)) {
    const rootDir = await findProjectRoot(startDir);
    const settings = readSettings(vscode.Uri.file(startDir));
    const loaded = await loadConfig(rootDir, {
      commentLevel: settings.commentLevel,
    });
    if (loaded.mode === "refactor") {
      run.notes.push(
        `.whycoderc.json in ${rootDir} asks for refactor mode, which the VS Code extension doesn't offer; safe mode is used, so logic never changes.`,
      );
    }
    const config: WhycodeConfig = { ...loaded, mode: "safe" };
    const collection = await collectFiles({
      rootDir,
      cwd: rootDir,
      paths: group,
      config,
      adapters,
    });
    run.skipped.push(
      ...collection.skipped.map(({ path, reason }) => ({ path, reason })),
    );
    const files: CollectedFile[] = [];
    for (const file of collection.files) {
      if (hasUnsavedChanges(file.absolutePath)) {
        run.skipped.push({ path: file.path, reason: UNSAVED_REASON });
      } else {
        files.push(file);
      }
    }
    run.projects.push({ rootDir, config, provider: settings.provider, files });
  }
  return run;
}

/** Groups paths by where the project search starts: their workspace folder, else their own folder. */
function groupByStartFolder(paths: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path));
    const start = folder?.uri.fsPath ?? dirname(path);
    groups.set(start, [...(groups.get(start) ?? []), path]);
  }
  return groups;
}

/** True when the file is open in an editor with edits that aren't saved yet. */
export function hasUnsavedChanges(absolutePath: string): boolean {
  return vscode.workspace.textDocuments.some(
    (document) =>
      document.isDirty &&
      document.uri.scheme === "file" &&
      samePath(document.uri.fsPath, absolutePath),
  );
}

function samePath(a: string, b: string): boolean {
  // Windows paths are case-insensitive, and VS Code lowercases drive letters.
  const normalize = (path: string) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return normalize(a) === normalize(b);
}
