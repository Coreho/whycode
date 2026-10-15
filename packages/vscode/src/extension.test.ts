// Tests for activation: what gets registered, and that a registered command
// runs a clean-up with the real language adapters. Ruby gets comments only,
// so this needs no tree-sitter grammars (bundle.test.ts covers those).
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentAboveFirstMatch } from "@whycode/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { activate } from "./extension.js";
import { PROPOSAL_SCHEME } from "./proposals.js";
import { fake, fakeChatModel, pick } from "./testing/fake-vscode.js";

let root: string;

beforeEach(async () => {
  fake.reset();
  root = await mkdtemp(join(tmpdir(), "whycode-extension-"));
  await mkdir(join(root, ".git"));
  fake.workspaceFolders = [root];
});

afterEach(() => rm(root, { recursive: true, force: true }));

function activateExtension(): { subscriptions: unknown[] } {
  const context = { subscriptions: [], extensionPath: root };
  activate(context as unknown as vscode.ExtensionContext);
  return context;
}

describe("activate", () => {
  it("registers both commands and the proposal documents", () => {
    const context = activateExtension();
    expect([...fake.commands.keys()]).toEqual([
      "whycode.cleanUpFile",
      "whycode.cleanUp",
    ]);
    expect(fake.contentProviders.has(PROPOSAL_SCHEME)).toBe(true);
    expect(context.subscriptions).toHaveLength(4);
  });

  it("cleans up the active editor's file from the Command Palette", async () => {
    const path = join(root, "app.rb");
    await writeFile(path, "def total(items)\n  items.sum\nend\n", "utf8");
    fake.activeFile = path;
    const reply = commentAboveFirstMatch(/^def total/, "Adds up the items.");
    fake.models = [
      fakeChatModel({ id: "claude-sonnet-5.5" }, (prompt) =>
        reply({ system: "", user: prompt }),
      ),
    ];
    fake.quickPickAnswers.push(pick("Apply"));
    activateExtension();

    await fake.runCommand("whycode.cleanUpFile");

    expect(fake.quickPicks[0]?.placeHolder).toMatch(/^Comments only/);
    expect(await readFile(path, "utf8")).toBe(
      "# Adds up the items.\ndef total(items)\n  items.sum\nend\n",
    );
  });

  it("asks for a file when the palette command has nothing to act on", async () => {
    activateExtension();
    await fake.runCommand("whycode.cleanUpFile");
    expect(fake.messages[0]?.text).toMatch(/^WhyCode: open a file/);
  });
});
