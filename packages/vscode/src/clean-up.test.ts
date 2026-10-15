// End-to-end tests of a clean-up run with the fake VS Code API, a scripted
// language model and the toy language: from the chosen files, through the
// diff view and the quick picks, to what is written to disk.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExistingCommentSuggestion } from "@whycode/core";
import {
  commentAboveFirstMatch,
  commentPlanReply,
  createToyAdapter,
} from "@whycode/core/testing";
import type { ToyAdapterOptions } from "@whycode/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import type { CleanUpDeps } from "./clean-up.js";
import { CONFIRM_ABOVE_FILES, cleanUp } from "./clean-up.js";
import { PROPOSAL_SCHEME, ProposalDocuments } from "./proposals.js";
import type { QuickPickAnswer } from "./testing/fake-vscode.js";
import {
  dismiss,
  fake,
  fakeChatModel,
  pick,
  pickMany,
} from "./testing/fake-vscode.js";

const cartCode = "fn total items\n  sum = add items\n  return sum\n";
const commentedCart = `# Adds up the items.\n${cartCode}`;

let root: string;

beforeEach(async () => {
  fake.reset();
  root = await mkdtemp(join(tmpdir(), "whycode-vscode-"));
  await mkdir(join(root, ".git"));
  fake.workspaceFolders = [root];
});

afterEach(() => rm(root, { recursive: true, force: true }));

async function writeFiles(files: Record<string, string>): Promise<void> {
  for (const [path, code] of Object.entries(files)) {
    await writeFile(join(root, path), code, "utf8");
  }
}

const readProjectFile = (path: string) => readFile(join(root, path), "utf8");

/** A Claude model in VS Code that puts one comment above the "fn total" line. */
function useCommentingModel() {
  const reply = commentAboveFirstMatch(/fn total/, "Adds up the items.");
  const model = fakeChatModel(
    { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
    (prompt) => reply({ system: "", user: prompt }),
  );
  fake.models = [model];
  return model;
}

function answer(...answers: QuickPickAnswer[]): void {
  fake.quickPickAnswers.push(...answers);
}

function run(
  paths: string[],
  options: { env?: CleanUpDeps["env"]; toy?: ToyAdapterOptions } = {},
): Promise<void> {
  const proposals = new ProposalDocuments();
  fake.contentProviders.set(PROPOSAL_SCHEME, proposals);
  const targets = paths.map((path) => vscode.Uri.file(join(root, path)));
  return cleanUp(targets, {
    output: fake.output,
    proposals,
    adapters: [createToyAdapter(options.toy)],
    env: options.env ?? {},
  });
}

const output = () => fake.output.lines.join("\n");

describe("reviewing a file's changes", () => {
  it("shows the proposal in the diff view and writes it when applied", async () => {
    await writeFiles({ "cart.toy": cartCode });
    const model = useCommentingModel();
    answer(pick("Apply"));

    await run(["cart.toy"]);

    expect(await readProjectFile("cart.toy")).toBe(commentedCart);
    expect(fake.diffs).toEqual([
      expect.objectContaining({
        title: "cart.toy (WhyCode proposal)",
        proposal: commentedCart,
      }),
    ]);
    expect(fake.diffs[0]?.left.fsPath).toBe(join(root, "cart.toy"));
    expect(fake.diffs[0]?.right.scheme).toBe(PROPOSAL_SCHEME);
    expect(fake.quickPicks[0]?.title).toBe("WhyCode: cart.toy (1 of 1)");
    expect(output()).toContain(
      "with Claude Sonnet 5.5 (VS Code language model), light comments",
    );
    expect(output()).toContain("Written (1):\n  cart.toy");
    expect(model.prompts[0]).toContain("Comment level: light");
    expect(fake.messages.at(-1)).toMatchObject({
      kind: "info",
      text: "WhyCode: 1 written.",
    });
  });

  it("leaves the file alone when the changes are discarded", async () => {
    await writeFiles({ "cart.toy": cartCode });
    useCommentingModel();
    answer(pick("Discard"));

    await run(["cart.toy"]);

    expect(await readProjectFile("cart.toy")).toBe(cartCode);
    expect(output()).toContain("Discarded (1):\n  cart.toy");
  });

  it.each([
    ["Stop", pick("Stop")],
    ["Escape", dismiss],
  ])("%s leaves this file and the rest unreviewed", async (_name, choice) => {
    await writeFiles({ "a.toy": cartCode, "b.toy": cartCode });
    useCommentingModel();
    answer(choice);

    await run(["a.toy", "b.toy"]);

    expect(fake.quickPicks).toHaveLength(1);
    expect(await readProjectFile("a.toy")).toBe(cartCode);
    expect(await readProjectFile("b.toy")).toBe(cartCode);
    expect(output()).toContain("Not reviewed (you stopped) (2):");
  });

  it("never overwrites a file that changed while it was being reviewed", async () => {
    await writeFiles({ "cart.toy": cartCode });
    useCommentingModel();
    answer((items, options) => {
      void writeFile(join(root, "cart.toy"), "edited meanwhile\n", "utf8");
      return pick("Apply")(items, options);
    });

    await run(["cart.toy"]);

    expect(await readProjectFile("cart.toy")).toBe("edited meanwhile\n");
    expect(output()).toContain(
      "not written: the file changed on disk since it was read",
    );
    expect(fake.messages.at(-1)?.kind).toBe("warning");
  });

  it("says when only formatting is proposed, without logging the code", async () => {
    await writeFiles({ "cart.toy": "fn total items   \n  return items\n" });
    useCommentingModel();
    answer(pick("Apply"));

    // The re-format after inserting comments changes a token, so the
    // logic check fails and only the first formatting is kept.
    await run(["cart.toy"], {
      toy: {
        corruptOnReformat: (code) =>
          code.replace("return items", "return leaked"),
      },
    });

    expect(fake.quickPicks[0]?.placeHolder).toMatch(
      /^Only formatting is proposed/,
    );
    expect(await readProjectFile("cart.toy")).toBe(
      "fn total items\n  return items\n",
    );
    expect(output()).toContain(
      "Comments discarded because verification failed; only formatting offered (1):",
    );
    expect(output()).toContain('expected "...", found "..."');
    expect(output()).not.toContain("leaked");
  });
});

describe("suggested rewrites of existing comments", () => {
  const code = [
    "fn total items",
    "  # old note",
    "  sum = add items",
    "  # second note",
    "  return sum",
    "",
  ].join("\n");
  const suggestion = (
    line: number,
    original: string,
    suggested: string,
  ): ExistingCommentSuggestion => ({
    line,
    original,
    suggested,
    reason: "More specific.",
  });
  const suggestions = [
    suggestion(2, "# old note", "# Sum of the item prices."),
    suggestion(4, "# second note", "# Callers expect a number."),
  ];

  function useSuggestingModel(withInsertion: boolean) {
    const reply = commentPlanReply({
      insertions: withInsertion
        ? [{ line: 1, position: "above", text: "Adds up the items." }]
        : [],
      existingCommentSuggestions: suggestions,
    });
    fake.models = [fakeChatModel({ id: "claude-sonnet-5.5" }, () => reply)];
  }

  it("are offered with nothing ticked, and only the picked ones are applied", async () => {
    await writeFiles({ "cart.toy": code });
    useSuggestingModel(true);
    answer(pick("Apply"), pickMany("Sum of"));

    await run(["cart.toy"]);

    // Line numbers refer to the processed code, one line further down.
    expect(fake.quickPicks[1]).toMatchObject({
      canPickMany: true,
      labels: [
        "Line 3: # Sum of the item prices.",
        "Line 5: # Callers expect a number.",
      ],
    });
    expect(await readProjectFile("cart.toy")).toBe(
      code
        .replace("fn total", "# Adds up the items.\nfn total")
        .replace("# old note", "# Sum of the item prices."),
    );
  });

  it("are not offered when the file's changes are discarded", async () => {
    await writeFiles({ "cart.toy": code });
    useSuggestingModel(true);
    answer(pick("Discard"));

    await run(["cart.toy"]);

    expect(fake.quickPicks).toHaveLength(1);
    expect(await readProjectFile("cart.toy")).toBe(code);
    expect(output()).toContain("were not offered");
  });

  it("are offered on their own when the file has no other changes", async () => {
    await writeFiles({ "cart.toy": code });
    useSuggestingModel(false);
    answer(pickMany("Callers"));

    await run(["cart.toy"]);

    expect(fake.diffs).toHaveLength(0);
    expect(await readProjectFile("cart.toy")).toBe(
      code.replace("# second note", "# Callers expect a number."),
    );
  });
});

describe("choosing what to process", () => {
  it("never reads gitignored, secret or unsaved files", async () => {
    await writeFiles({
      ".gitignore": "ignored.toy\n",
      "ignored.toy": "fn ignored",
      ".env": "TOKEN=abc",
      "unsaved.toy": "fn unsaved",
      "cart.toy": cartCode,
    });
    fake.documents = [
      { uri: vscode.Uri.file(join(root, "unsaved.toy")), isDirty: true },
    ];
    const model = useCommentingModel();
    answer(pick("Discard"));

    await run(["."]);

    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain("File: cart.toy");
    expect(output()).toMatch(/ignored by \.gitignore:\n\s+ignored\.toy/);
    expect(output()).toMatch(/may hold secrets.*:\n\s+\.env/);
    expect(output()).toMatch(/has unsaved changes.*:\n\s+unsaved\.toy/);
  });

  it("uses safe mode even when .whycoderc.json asks for refactor mode", async () => {
    await writeFiles({
      ".whycoderc.json": '{ "mode": "refactor" }',
      "cart.toy": cartCode,
    });
    const model = useCommentingModel();
    answer(pick("Apply"));

    await run(["cart.toy"]);

    expect(model.prompts[0]).not.toContain("You refactor source code");
    expect(await readProjectFile("cart.toy")).toBe(commentedCart);
    expect(output()).toContain("safe mode is used, so logic never changes");
  });

  it("lets the comment level setting override .whycoderc.json", async () => {
    await writeFiles({
      ".whycoderc.json": '{ "commentLevel": "medium" }',
      "cart.toy": cartCode,
    });
    const model = useCommentingModel();
    answer(pick("Discard"), pick("Discard"));

    await run(["cart.toy"]);
    fake.settings["whycode.commentLevel"] = "heavy";
    await run(["cart.toy"]);

    expect(model.prompts[0]).toContain("Comment level: medium");
    expect(model.prompts[1]).toContain("Comment level: heavy");
  });

  it("asks before sending more files than usual, and stops on no", async () => {
    const files = Object.fromEntries(
      Array.from({ length: CONFIRM_ABOVE_FILES + 1 }, (_, index) => [
        `f${index}.toy`,
        cartCode,
      ]),
    );
    await writeFiles(files);
    const model = useCommentingModel();

    await run(["."]);

    expect(fake.messages[0]).toMatchObject({
      kind: "warning",
      modal: true,
      text: `WhyCode will send ${CONFIRM_ABOVE_FILES + 1} files to an AI model, one request each. Continue?`,
    });
    expect(model.prompts).toHaveLength(0);
  });

  it("explains what to do when there is nothing to act on", async () => {
    await cleanUp([], {
      output: fake.output,
      proposals: new ProposalDocuments(),
      adapters: [createToyAdapter()],
      env: {},
    });
    await cleanUp([vscode.Uri.file(root).with({ scheme: "untitled" })], {
      output: fake.output,
      proposals: new ProposalDocuments(),
      adapters: [createToyAdapter()],
      env: {},
    });

    expect(fake.messages.map((message) => message.text)).toEqual([
      "WhyCode: open a file, or select files or folders in the Explorer, to clean them up.",
      "WhyCode only cleans up files saved on disk.",
    ]);
  });
});

describe("progress and failures", () => {
  it("stops starting files once cancelled, and writes nothing", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`f${index}.toy`, cartCode]),
    );
    await writeFiles(files);
    const reply = commentAboveFirstMatch(/fn total/, "Adds up the items.");
    const model = fakeChatModel({ id: "claude-sonnet-5.5" }, (prompt) => {
      fake.cancellation.isCancellationRequested = true;
      return reply({ system: "", user: prompt });
    });
    fake.models = [model];

    await run(["."]);

    expect(model.prompts.length).toBeLessThan(8);
    expect(fake.quickPicks).toHaveLength(0);
    expect(fake.messages.at(-1)?.text).toBe(
      "WhyCode: cancelled. Nothing was written.",
    );
    expect(await readProjectFile("f0.toy")).toBe(cartCode);
  });

  it("lists files the AI failed on", async () => {
    await writeFiles({ "cart.toy": cartCode });
    fake.models = [fakeChatModel({ id: "claude" }, () => "not JSON")];

    await run(["cart.toy"]);

    expect(output()).toContain(
      "Could not process 1 file:\n  AI returned an invalid reply 2 times. AI response is not valid JSON.:\n    cart.toy",
    );
    expect(fake.messages.at(-1)?.kind).toBe("warning");
  });

  it("explains how to set up an AI when there is no model and no key", async () => {
    await writeFiles({ "cart.toy": cartCode });

    await run(["cart.toy"]);

    expect(fake.messages.at(-1)).toMatchObject({ kind: "error" });
    expect(fake.messages.at(-1)?.text).toMatch(/GitHub Copilot/);
    expect(fake.messages.at(-1)?.text).toMatch(/ANTHROPIC_API_KEY is not set/);
  });
});
