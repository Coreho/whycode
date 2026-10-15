// Reads WhyCode's VS Code settings for one folder. The comment level
// overrides .whycoderc.json only when someone actually set it, so the
// setting's default never hides the project's own choice.
import type { CommentLevel } from "@whycode/core";
import * as vscode from "vscode";

export type ProviderSetting = "auto" | "vscode" | "anthropic" | "openrouter";

export interface WhycodeSettings {
  /** Undefined when nobody set it, so .whycoderc.json decides. */
  commentLevel: CommentLevel | undefined;
  provider: ProviderSetting;
}

const COMMENT_LEVELS: readonly CommentLevel[] = ["light", "medium", "heavy"];
const PROVIDERS: readonly ProviderSetting[] = [
  "auto",
  "vscode",
  "anthropic",
  "openrouter",
];

export function readSettings(scope: vscode.Uri | undefined): WhycodeSettings {
  const settings = vscode.workspace.getConfiguration("whycode", scope);
  const level = settings.inspect<string>("commentLevel");
  const chosenLevel =
    level?.workspaceFolderValue ?? level?.workspaceValue ?? level?.globalValue;
  const provider = settings.get<string>("provider");
  return {
    commentLevel: isOneOf(chosenLevel, COMMENT_LEVELS)
      ? chosenLevel
      : undefined,
    provider: isOneOf(provider, PROVIDERS) ? provider : "auto",
  };
}

function isOneOf<T extends string>(
  value: string | undefined,
  options: readonly T[],
): value is T {
  return options.some((option) => option === value);
}
