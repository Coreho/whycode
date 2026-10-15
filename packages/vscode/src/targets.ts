// Works out which files a command applies to. Explorer menus pass the
// clicked item and the whole selection, editor menus pass the file, and the
// Command Palette passes nothing, so the active editor's file is used.
import * as vscode from "vscode";

export function commandTargets(
  clicked: unknown,
  selected: unknown,
): vscode.Uri[] {
  if (isUriList(selected)) return selected;
  if (clicked instanceof vscode.Uri) return [clicked];
  const active = vscode.window.activeTextEditor?.document.uri;
  return active === undefined ? [] : [active];
}

function isUriList(value: unknown): value is vscode.Uri[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => item instanceof vscode.Uri)
  );
}
