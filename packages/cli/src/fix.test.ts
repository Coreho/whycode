// End-to-end tests for `whycode fix`: scripted answers stand in for the
// person at the terminal, and the real core pipeline runs on toy files.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FakeResponse } from "@whycode/core/testing";
import {
  commentAboveFirstMatch,
  commentPlanReply,
  createToyAdapter,
  FakeAIProvider,
} from "@whycode/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { describeTestCommand } from "./fix.js";
import type { CliIo } from "./io.js";
import type { CommandDeps } from "./run.js";

describe("whycode fix", () => {
  let root: string;
  let stdout: string;
  let stderr: string;
  let questions: string[];
  let provider: FakeAIProvider;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "whycode-fix-"));
    await mkdir(join(root, ".git"));
    stdout = "";
    stderr = "";
    questions = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function files(entries: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(entries)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
  }

  const read = (path: string) => readFile(join(root, path), "utf8");

  /** A terminal whose user gives `answers` in order (undefined = Ctrl+C). */
  function terminal(
    answers: (string | undefined)[],
    options: { interactive?: boolean; onAsk?: () => Promise<void> } = {},
  ): CliIo {
    return {
      cwd: root,
      env: {},
      stdout: (text) => void (stdout += text),
      stderr: (text) => void (stderr += text),
      color: false,
      interactive: options.interactive ?? true,
      readStdin: () => Promise.resolve(""),
      ask: async (question) => {
        questions.push(question);
        await options.onAsk?.();
        return answers.shift();
      },
    };
  }

  function deps(
    responses: FakeResponse | FakeResponse[],
    adapter = createToyAdapter(),
  ): CommandDeps {
    provider = new FakeAIProvider(responses);
    return {
      adapters: [adapter],
      createProvider: () => provider,
      concurrency: 1,
    };
  }

  const commentOn = (word: string) =>
    commentAboveFirstMatch(new RegExp(word), `About ${word}.`);

  it("writes accepted files, keeping CRLF line endings, and nothing else", async () => {
    await files({
      "a.toy": "alpha\r\n",
      "b.toy": "beta\n",
      "c.toy": "gamma\n",
    });
    const code = await runCli(
      ["fix", "."],
      terminal(["y", "n", "s"]),
      deps([commentOn("alpha"), commentOn("beta"), commentOn("gamma")]),
    );
    expect(code).toBe(0);
    expect(await read("a.toy")).toBe("# About alpha.\r\nalpha\r\n");
    expect(await read("b.toy")).toBe("beta\n");
    expect(await read("c.toy")).toBe("gamma\n");
    expect(questions).toEqual([
      "Apply these changes to a.toy? [y]es / [n]o / [s]kip / [q]uit: ",
      "Apply these changes to b.toy? [y]es / [n]o / [s]kip / [q]uit: ",
      "Apply these changes to c.toy? [y]es / [n]o / [s]kip / [q]uit: ",
    ]);
    expect(stdout).toContain("+# About alpha.");
    expect(stdout).toContain(
      [
        "Summary:",
        "  written (1):",
        "    a.toy",
        "  rejected (1):",
        "    b.toy",
        "  skipped (1):",
        "    c.toy",
      ].join("\n"),
    );
  });

  it("asks again after an answer it doesn't understand", async () => {
    await files({ "a.toy": "alpha\n" });
    await runCli(
      ["fix", "a.toy"],
      terminal(["", "maybe", "yes"]),
      deps(commentOn("alpha")),
    );
    expect(questions).toHaveLength(3);
    expect(await read("a.toy")).toBe("# About alpha.\nalpha\n");
  });

  it("offers comment suggestions one at a time and applies only accepted ones", async () => {
    await files({ "a.toy": "# one\nalpha\n# two\nbeta\n" });
    const reply = commentPlanReply({
      insertions: [{ line: 2, position: "above", text: "New." }],
      existingCommentSuggestions: [
        { line: 1, original: "# one", suggested: "# First.", reason: "r1" },
        { line: 3, original: "# two", suggested: "# Second.", reason: "r2" },
      ],
    });
    await runCli(["fix", "a.toy"], terminal(["y", "y", "n"]), deps(reply));
    expect(questions).toEqual([
      "Apply these changes to a.toy? [y]es / [n]o / [s]kip / [q]uit: ",
      "Apply this suggestion? [y]es / [n]o / [q]uit: ",
      "Apply this suggestion? [y]es / [n]o / [q]uit: ",
    ]);
    expect(stdout).toContain("(1 of 2)");
    expect(stdout).toContain("(2 of 2)");
    expect(await read("a.toy")).toBe("# First.\n# New.\nalpha\n# two\nbeta\n");
  });

  it("offers suggestions for a file with no other changes", async () => {
    await files({ "a.toy": "# old\nalpha\n" });
    const reply = commentPlanReply({
      existingCommentSuggestions: [
        { line: 1, original: "# old", suggested: "# New.", reason: "r" },
      ],
    });
    await runCli(["fix", "a.toy"], terminal(["y"]), deps(reply));
    expect(questions).toEqual([
      "Apply this suggestion? [y]es / [n]o / [q]uit: ",
    ]);
    expect(await read("a.toy")).toBe("# New.\nalpha\n");
  });

  it("doesn't offer suggestions when the file's changes were rejected", async () => {
    await files({ "a.toy": "# old\nalpha\n" });
    const reply = commentPlanReply({
      insertions: [{ line: 2, position: "above", text: "New." }],
      existingCommentSuggestions: [
        { line: 1, original: "# old", suggested: "# Better.", reason: "r" },
      ],
    });
    await runCli(["fix", "a.toy"], terminal(["n"]), deps(reply));
    expect(questions).toHaveLength(1);
    expect(stdout).toContain("Not offered: 1 suggested rewrite(s)");
    expect(await read("a.toy")).toBe("# old\nalpha\n");
  });

  it("with --yes, writes every file without asking but never edits existing comments", async () => {
    await files({ "a.toy": "# old\nalpha\n" });
    const reply = commentPlanReply({
      insertions: [{ line: 2, position: "above", text: "New." }],
      existingCommentSuggestions: [
        { line: 1, original: "# old", suggested: "# Better.", reason: "r" },
      ],
    });
    const code = await runCli(
      ["fix", "a.toy", "--yes"],
      terminal([], { interactive: false }),
      deps(reply),
    );
    expect(code).toBe(0);
    expect(questions).toEqual([]);
    expect(await read("a.toy")).toBe("# old\n# New.\nalpha\n");
    expect(stdout).toContain("--yes never edits existing comments");
  });

  it("writes nothing and explains why without a terminal or --yes", async () => {
    await files({ "a.toy": "alpha\n" });
    const code = await runCli(
      ["fix", "a.toy"],
      terminal([], { interactive: false }),
      deps(commentOn("alpha")),
    );
    expect(code).toBe(2);
    expect(stderr).toContain(
      "nothing was written because there is no terminal",
    );
    expect(provider.requests).toHaveLength(0);
    expect(await read("a.toy")).toBe("alpha\n");
  });

  it("stops at quit, leaving later files unreviewed and untouched", async () => {
    await files({ "a.toy": "alpha\n", "b.toy": "beta\n", "c.toy": "gamma\n" });
    await runCli(
      ["fix", "."],
      terminal(["q"]),
      deps([commentOn("alpha"), commentOn("beta"), commentOn("gamma")]),
    );
    expect(questions).toHaveLength(1);
    expect(await read("a.toy")).toBe("alpha\n");
    expect(stdout).toContain(
      [
        "  not reviewed (you quit) (3):",
        "    a.toy",
        "    b.toy",
        "    c.toy",
      ].join("\n"),
    );
  });

  it("treats Ctrl+C at a prompt as quit", async () => {
    await files({ "a.toy": "alpha\n" });
    const code = await runCli(
      ["fix", "a.toy"],
      terminal([undefined]),
      deps(commentOn("alpha")),
    );
    expect(code).toBe(0);
    expect(await read("a.toy")).toBe("alpha\n");
  });

  it("never overwrites a file that was edited during the review", async () => {
    await files({ "a.toy": "alpha\n" });
    const code = await runCli(
      ["fix", "a.toy"],
      terminal(["y"], {
        onAsk: () => writeFile(join(root, "a.toy"), "edited\n"),
      }),
      deps(commentOn("alpha")),
    );
    expect(code).toBe(2);
    expect(await read("a.toy")).toBe("edited\n");
    expect(stdout).toContain(
      "not written: the file changed on disk since it was read",
    );
  });

  it("shows the verdict and notes for a file with nothing to write", async () => {
    await files({ "a.toy": "alpha\n" });
    const corrupting = createToyAdapter({
      corruptOnReformat: (code) => `${code}\nextra`,
    });
    await runCli(
      ["fix", "a.toy"],
      terminal([]),
      deps(commentOn("alpha"), corrupting),
    );
    expect(questions).toEqual([]);
    expect(stdout).toContain(
      "a.toy: comments discarded because verification failed; nothing else to change",
    );
    expect(stdout).toMatch(
      /Notes for a\.toy:\n {2}- AI comments were discarded/,
    );
  });

  it("lists files whose verification failed, with only formatting offered", async () => {
    await files({ "a.toy": "alpha   \n" });
    const corrupting = createToyAdapter({
      corruptOnReformat: (code) => `${code}\nextra`,
    });
    await runCli(
      ["fix", "a.toy"],
      terminal(["y"]),
      deps(commentOn("alpha"), corrupting),
    );
    expect(await read("a.toy")).toBe("alpha\n");
    expect(stdout).toContain(
      [
        "  verification failed, so only formatting was offered (1):",
        "    a.toy",
      ].join("\n"),
    );
  });

  describe("--refactor", () => {
    const rewrite = JSON.stringify({
      code: "omega\n",
      changes: ["Renamed alpha to omega."],
    });

    it("asks for confirmation first and changes nothing when declined", async () => {
      await files({ "a.toy": "alpha\n" });
      const code = await runCli(
        ["fix", "a.toy", "--refactor"],
        terminal(["n"]),
        deps(rewrite),
      );
      expect(code).toBe(0);
      expect(stdout).toContain(
        "Refactor mode rewrites your code, so its logic WILL change.",
      );
      expect(questions).toEqual(["Continue? [y/N] "]);
      expect(provider.requests).toHaveLength(0);
      expect(await read("a.toy")).toBe("alpha\n");
      expect(stdout).toContain("No testCommand is set in .whycoderc.json");
    });

    it("shows the exact testCommand that will run in a shell before asking", async () => {
      await files({
        "a.toy": "alpha\n",
        ".whycoderc.json": JSON.stringify({ testCommand: "npm test" }),
      });
      await runCli(
        ["fix", "a.toy", "--refactor"],
        terminal(["n"]),
        deps(rewrite),
      );
      expect(stdout).toContain(
        "this testCommand from .whycoderc.json runs in a shell in",
      );
      expect(stdout).toContain("\n  npm test\n");
    });

    it("warns on every rewritten file and still asks before writing it", async () => {
      await files({ "a.toy": "alpha\n" });
      await runCli(
        ["fix", "a.toy", "--refactor"],
        terminal(["y", "y"]),
        deps(rewrite),
      );
      expect(questions).toEqual([
        "Continue? [y/N] ",
        "Apply these changes to a.toy? [y]es / [n]o / [s]kip / [q]uit: ",
      ]);
      expect(stdout).toContain(
        "WARNING: this rewrite of a.toy may change how the code behaves.",
      );
      expect(stdout).toContain("  - Renamed alpha to omega.");
      expect(await read("a.toy")).toBe("omega\n");
    });

    it("is refused with --yes, including refactor mode from the config file", async () => {
      await files({ "a.toy": "alpha\n" });
      expect(
        await runCli(
          ["fix", "a.toy", "--refactor", "--yes"],
          terminal([]),
          deps(rewrite),
        ),
      ).toBe(2);
      expect(stderr).toMatch(/--yes can't be combined with --refactor/);

      await files({ ".whycoderc.json": JSON.stringify({ mode: "refactor" }) });
      expect(
        await runCli(["fix", "a.toy", "--yes"], terminal([]), deps(rewrite)),
      ).toBe(2);
      expect(stderr).toMatch(/--yes can't be used in refactor mode/);
      expect(await read("a.toy")).toBe("alpha\n");
    });
  });
});

describe("describeTestCommand", () => {
  it("makes line breaks and hidden characters in the command visible", () => {
    const override = String.fromCharCode(0x202e);
    const escape = String.fromCharCode(27);
    const text = describeTestCommand(
      `npm test${override}\ncurl x${escape}`,
      "/repo",
    );
    expect(text).toContain("npm test\\u{202e}\\ncurl x\\u{1b}\n");
    expect(text).not.toContain(override);
    expect(text).not.toContain(escape);
  });
});
