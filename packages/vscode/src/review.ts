// Reviews a run's results with the user, one file at a time: the proposal
// opens in VS Code's diff view and a quick pick asks whether to apply it.
// Suggested rewrites of existing comments come in a separate list where
// nothing is ticked, so an existing comment only changes when the user
// picks its rewrite. Files are written only through core's writeSourceFile,
// which refuses when a file changed on disk since it was read.
import type {
  CollectedFile,
  ExistingCommentSuggestion,
  FileResult,
  LanguageAdapter,
} from "@whycode/core";
import { applyCommentSuggestions, writeSourceFile } from "@whycode/core";
import * as vscode from "vscode";
import { hasUnsavedChanges } from "./projects.js";
import type { ProposalDocuments } from "./proposals.js";
import { closeProposalDiff, showProposalDiff } from "./proposals.js";
import type { RunTally } from "./report.js";

type Decision = "apply" | "discard" | "stop";

interface DecisionItem extends vscode.QuickPickItem {
  decision: Decision;
}

interface SuggestionItem extends vscode.QuickPickItem {
  suggestion: ExistingCommentSuggestion;
}

export interface Position {
  index: number;
  total: number;
}

export class ReviewSession {
  /** Set when the user chose Stop: the remaining files are left alone. */
  stopped = false;

  constructor(
    private readonly tally: RunTally,
    private readonly proposals: ProposalDocuments,
    private readonly adapters: readonly LanguageAdapter[],
    private readonly log: (line: string) => void,
  ) {}

  /** Reviews one file that has changes or comment suggestions. */
  async review(
    file: CollectedFile,
    result: FileResult,
    position: Position,
  ): Promise<void> {
    const hasChanges = result.status === "changed";
    const decision = hasChanges
      ? await this.decide(file, result, position)
      : "discard";
    if (decision === "stop") {
      this.stopped = true;
      this.tally.notReviewed.push(result.path);
      return;
    }

    // Suggestions are numbered against the processed code, so they are
    // offered only when that code is kept (or the file had no other changes).
    const keepsChanges = decision === "apply";
    const suggestions = await this.chooseSuggestions(
      result,
      keepsChanges || !hasChanges,
    );
    const base = keepsChanges ? result.outputCode : result.originalCode;
    const finalCode = await this.withSuggestions(
      result.path,
      base,
      suggestions,
    );
    if (finalCode !== result.originalCode) {
      await this.write(file, result, finalCode);
    } else {
      (hasChanges ? this.tally.discarded : this.tally.unchanged).push(
        result.path,
      );
    }
  }

  private async decide(
    file: CollectedFile,
    result: FileResult,
    position: Position,
  ): Promise<Decision> {
    const proposal = this.proposals.add(file.absolutePath, result.outputCode);
    try {
      await showProposalDiff(
        file.absolutePath,
        proposal,
        `${result.path} (WhyCode proposal)`,
      );
      const picked = await vscode.window.showQuickPick(
        decisionItems(position.total - position.index),
        {
          title: `WhyCode: ${result.path} (${position.index} of ${position.total})`,
          placeHolder: reviewHint(result),
          // Stay open while the user scrolls through the diff.
          ignoreFocusOut: true,
        },
      );
      // Escape stops the review, like Ctrl+C in the CLI: nothing is written.
      return picked?.decision ?? "stop";
    } finally {
      await closeProposalDiff(proposal);
      this.proposals.remove(proposal);
    }
  }

  private async chooseSuggestions(
    result: FileResult,
    offer: boolean,
  ): Promise<ExistingCommentSuggestion[]> {
    const suggestions = result.commentSuggestions;
    if (suggestions.length === 0) return [];
    if (!offer) {
      this.log(
        `${result.path}: ${suggestions.length} suggested rewrite(s) of existing comments were not offered, because its changes were discarded.`,
      );
      return [];
    }
    const picked = await vscode.window.showQuickPick(
      suggestions.map(suggestionItem),
      {
        title: `WhyCode: suggested rewrites of existing comments in ${result.path}`,
        placeHolder:
          "Tick the rewrites to apply. Comments you don't tick stay as they are.",
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    return (picked ?? []).map((item) => item.suggestion);
  }

  private async withSuggestions(
    path: string,
    code: string,
    suggestions: readonly ExistingCommentSuggestion[],
  ): Promise<string> {
    if (suggestions.length === 0) return code;
    const applied = await applyCommentSuggestions(
      path,
      code,
      suggestions,
      this.adapters,
    );
    for (const { suggestion, reason } of applied.notApplied) {
      this.log(
        `${path}: the suggestion for line ${suggestion.line} was not applied: ${reason}.`,
      );
    }
    return applied.code;
  }

  private async write(
    file: CollectedFile,
    result: FileResult,
    code: string,
  ): Promise<void> {
    // Writing under unsaved edits would leave the editor in conflict with disk.
    const outcome = hasUnsavedChanges(file.absolutePath)
      ? { ok: false as const, reason: "it has unsaved changes in the editor" }
      : await writeSourceFile(file.absolutePath, code, result.originalCode);
    if (outcome.ok) {
      this.tally.written.push(result.path);
    } else {
      this.tally.failed.push({
        path: result.path,
        reason: `not written: ${outcome.reason}`,
      });
    }
  }
}

function decisionItems(remaining: number): DecisionItem[] {
  return [
    {
      label: "$(check) Apply",
      description: "Write these changes to the file",
      decision: "apply",
    },
    {
      label: "$(discard) Discard",
      description: "Leave the file as it is",
      decision: "discard",
    },
    {
      label: "$(debug-stop) Stop",
      description:
        remaining > 0
          ? `Leave this file and the ${remaining} after it as they are`
          : "Leave the file as it is and stop",
      decision: "stop",
    },
  ];
}

/** What the user should know about this proposal before deciding. */
function reviewHint(result: FileResult): string {
  if (result.verification === "failed") {
    return "Only formatting is proposed: the AI's comments failed the check that the code's logic is unchanged.";
  }
  if (result.mode === "comments-only") {
    return "Comments only: this language gets no formatting and no logic check.";
  }
  return "Review the diff, then apply or discard the changes.";
}

function suggestionItem(suggestion: ExistingCommentSuggestion): SuggestionItem {
  return {
    label: `Line ${suggestion.line}: ${oneLine(suggestion.suggested)}`,
    description: suggestion.reason,
    detail: `Now: ${oneLine(suggestion.original)}`,
    picked: false,
    suggestion,
  };
}

function oneLine(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .join(" ");
}
