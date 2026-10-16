// Tests for --staged and --diff: only the files git reports as changed are
// processed, a partially staged file is passed over, and fix --staged tells
// the user how to stage what it wrote.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commentAboveFirstMatch,
  createToyAdapter,
  FakeAIProvider,
} from "@whycode/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCommandLine } from "./args.js";
import { runCli } from "./cli.js";
import { stagingNote } from "./fix.js";
import type { CliIo } from "./io.js";
import type { CommandDeps } from "./run.js";

describe("parsing --staged and --diff", () => {
  it("makes paths optional and keeps the scope", () => {
    expect(parseCommandLine(["check", "--diff", "origin/main"])).toEqual({
      kind: "check",
      paths: ["."],
      overrides: {},
      scope: { kind: "diff", ref: "origin/main" },
    });
    expect(parseCommandLine(["fix", "src", "--staged"])).toMatchObject({
      kind: "fix",
      paths: ["src"],
      scope: { kind: "staged" },
    });
  });

  it.each([
    [["check", "--staged", "--diff", "main"], /can't be combined/],
    [["check", "--diff", " "], /needs a git ref/],
    [["prompt", ".", "--staged"], /--staged doesn't apply/],
  ])("rejects %j", (argv, message) => {
    const parsed = parseCommandLine(argv);
    expect(parsed.kind === "error" && parsed.message).toMatch(message);
  });
});

describe("check and fix on changed files", () => {
  let repo: string;
  let stdout: string;
  let stderr: string;
  let provider: FakeAIProvider;

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const write = (path: string, content: string) =>
    writeFile(join(repo, path), content);
  const read = (path: string) => readFile(join(repo, path), "utf8");

  const io = (answers: string[] = []): CliIo => ({
    cwd: repo,
    env: {},
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    color: false,
    interactive: true,
    ask: () => Promise.resolve(answers.shift()),
    readStdin: () => Promise.resolve(""),
  });

  const deps = (): CommandDeps => {
    provider = new FakeAIProvider(commentAboveFirstMatch(/\w/, "Explains."));
    return {
      adapters: [createToyAdapter()],
      createProvider: () => provider,
      concurrency: 1,
    };
  };

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "whycode-scope-"));
    stdout = "";
    stderr = "";
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    for (const name of ["a", "b", "c"]) await write(`${name}.toy`, `${name}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("check --diff covers only files changed since the ref", async () => {
    git("checkout", "-q", "-b", "feature");
    await write("a.toy", "a\nmore\n");
    git("commit", "-q", "-am", "work");
    await write("new.toy", "fresh\n");

    const code = await runCli(["check", "--diff", "main"], io(), deps());
    expect(code).toBe(1);
    expect(
      provider.requests.map((r) => /File: (\S+)/.exec(r.user)?.[1]),
    ).toEqual(["a.toy", "new.toy"]);
    expect(stdout).not.toContain("b.toy");
  });

  it("fix --staged refuses a file with unstaged edits on top", async () => {
    await write("a.toy", "a\nstaged\n");
    await write("b.toy", "b\nstaged\n");
    git("add", "a.toy", "b.toy");
    await write("b.toy", "b\nstaged\nunstaged\n");

    await runCli(["fix", "--staged"], io(["y"]), deps());
    expect(provider.requests).toHaveLength(1);
    expect(await read("a.toy")).toBe("# Explains.\na\nstaged\n");
    expect(await read("b.toy")).toBe("b\nstaged\nunstaged\n");
    expect(stdout).toContain(
      "has unstaged changes as well as staged ones; stage or stash them first",
    );
  });

  it("check --staged skips a partially staged file too, since its working copy isn't what will be committed", async () => {
    await write("a.toy", "a\nstaged\n");
    await write("b.toy", "b\nstaged\n");
    git("add", "a.toy", "b.toy");
    await write("b.toy", "b\nstaged\nunstaged\n");

    await runCli(["check", "--staged"], io(), deps());
    expect(
      provider.requests.map((r) => /File: (\S+)/.exec(r.user)?.[1]),
    ).toEqual(["a.toy"]);
    expect(stdout).toContain(
      "has unstaged changes as well as staged ones; stage or stash them first",
    );
  });

  it("fix --staged names the git add command for the files it wrote, without staging them", async () => {
    await write("a.toy", "a\nstaged\n");
    git("add", "a.toy");

    await runCli(["fix", "--staged"], io(["y"]), deps());
    expect(await read("a.toy")).toBe("# Explains.\na\nstaged\n");
    expect(stdout).toContain(
      "The written changes are not staged yet. To commit them, stage them:\n  git add -- a.toy\n",
    );
    expect(git("diff", "--name-only")).toBe("a.toy\n");
  });

  it("reports a bad ref as an error before any AI call", async () => {
    const code = await runCli(["check", "--diff", "nope"], io(), deps());
    expect(code).toBe(2);
    expect(stderr).toMatch(/whycode: git merge-base failed/);
    expect(provider.requests).toHaveLength(0);
  });
});

describe("stagingNote", () => {
  it("names paths from the current folder and quotes ones a shell would split", () => {
    const root = join(tmpdir(), "project");
    expect(
      stagingNote(["src/a.ts", "src/my file.ts"], root, join(root, "src")),
    ).toBe(
      "\nThe written changes are not staged yet. To commit them, stage them:\n  git add -- a.ts 'my file.ts'\n",
    );
    expect(stagingNote([], root, root)).toBe("");
  });
});
