// Entry point VS Code loads: registers WhyCode's commands and the read-only
// documents that show proposed changes in the diff view.
import { join } from "node:path";
import { defaultAdapters, useGrammarDirectory } from "@whycode/core";
import * as vscode from "vscode";
import type { CleanUpDeps } from "./clean-up.js";
import { cleanUp } from "./clean-up.js";
import { PROPOSAL_SCHEME, ProposalDocuments } from "./proposals.js";
import { commandTargets } from "./targets.js";

export function activate(context: vscode.ExtensionContext): void {
  // The build copies the tree-sitter grammars here (scripts/build.mjs).
  useGrammarDirectory(join(context.extensionPath, "dist", "grammars"));
  const output = vscode.window.createOutputChannel("WhyCode");
  const proposals = new ProposalDocuments();
  const deps: CleanUpDeps = {
    output,
    proposals,
    adapters: defaultAdapters,
    env: process.env,
  };

  let running = false;
  // Explorer menus pass (clicked, selection); editor menus pass the file.
  const runCommand = async (clicked?: unknown, selected?: unknown) => {
    if (running) {
      void vscode.window.showInformationMessage(
        "WhyCode is already cleaning up files. Finish that review first.",
      );
      return;
    }
    running = true;
    try {
      await cleanUp(commandTargets(clicked, selected), deps);
    } finally {
      running = false;
    }
  };

  context.subscriptions.push(
    output,
    vscode.workspace.registerTextDocumentContentProvider(
      PROPOSAL_SCHEME,
      proposals,
    ),
    vscode.commands.registerCommand("whycode.cleanUpFile", runCommand),
    vscode.commands.registerCommand("whycode.cleanUp", runCommand),
  );
}

export function deactivate(): void {
  // Nothing to clean up: everything registered is in context.subscriptions.
}
