// Read-only documents holding WhyCode's proposed version of a file, so that
// VS Code's diff view can show it next to the file on disk. Every proposal
// gets a fresh URI, so a second run never shows a stale cached document.
import * as vscode from "vscode";

export const PROPOSAL_SCHEME = "whycode-proposal";

export class ProposalDocuments implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private nextId = 1;

  /** Stores a proposal for the file and returns the URI that shows it. */
  add(filePath: string, content: string): vscode.Uri {
    // Keeping the file's path gives the tab its name and language mode.
    const uri = vscode.Uri.file(filePath).with({
      scheme: PROPOSAL_SCHEME,
      query: String(this.nextId++),
    });
    this.contents.set(uri.toString(), content);
    return uri;
  }

  remove(uri: vscode.Uri): void {
    this.contents.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }
}

/** Opens the diff between a file on disk and its proposal. */
export async function showProposalDiff(
  filePath: string,
  proposal: vscode.Uri,
  title: string,
): Promise<void> {
  await vscode.commands.executeCommand(
    "vscode.diff",
    vscode.Uri.file(filePath),
    proposal,
    title,
    { preview: true },
  );
}

/** Closes the diff tabs showing a proposal once it has been decided on. */
export async function closeProposalDiff(proposal: vscode.Uri): Promise<void> {
  const tabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputTextDiff &&
        tab.input.modified.toString() === proposal.toString(),
    );
  if (tabs.length > 0) await vscode.window.tabGroups.close(tabs);
}
