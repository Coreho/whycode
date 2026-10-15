// Tests for listing changed files with git, and for collecting only those,
// against real temporary repositories.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAdapters } from "../languages/index.js";
import { collectFiles } from "./collect.js";
import { GitChangesError, listChangedFiles } from "./git-changes.js";

describe("listChangedFiles", () => {
  let repo: string;

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

  async function files(entries: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(entries)) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), content);
    }
  }

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "whycode-git-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    await files({
      "a.py": "a = 1\n",
      "b.py": "b = 1\n",
      "old.py": "o = 1\n",
      "sub/s.py": "s = 1\n",
    });
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("tag", "base");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("lists committed, uncommitted and untracked changes since a ref", async () => {
    await files({ "a.py": "a = 2\n" });
    git("rm", "-q", "b.py");
    git("mv", "old.py", "new.py");
    git("commit", "-q", "-am", "work");
    await files({ "sub/s.py": "s = 2\n", "fresh.py": "f = 1\n" });

    const changes = await listChangedFiles(repo, { kind: "diff", ref: "base" });
    expect(changes.paths).toEqual(["a.py", "fresh.py", "new.py", "sub/s.py"]);
  });

  it("lists staged files and spots partially staged ones", async () => {
    await files({ "a.py": "a = 2\n", "b.py": "b = 2\n" });
    git("add", "a.py", "b.py");
    await files({ "b.py": "b = 3\n", "sub/s.py": "s = 2\n" });

    const changes = await listChangedFiles(repo, { kind: "staged" });
    expect(changes.paths).toEqual(["a.py", "b.py"]);
    expect([...changes.partiallyStaged]).toEqual(["b.py"]);
  });

  it("gives paths relative to a project root inside the repository", async () => {
    await files({ "a.py": "a = 2\n", "sub/s.py": "s = 2\n" });
    const changes = await listChangedFiles(join(repo, "sub"), {
      kind: "diff",
      ref: "base",
    });
    expect(changes.paths).toEqual(["s.py"]);
  });

  it("explains a missing ref or a folder that isn't a repository", async () => {
    await expect(
      listChangedFiles(repo, { kind: "diff", ref: "no-such-ref" }),
    ).rejects.toThrow(GitChangesError);
    const plain = await mkdtemp(join(tmpdir(), "whycode-nogit-"));
    try {
      await expect(listChangedFiles(plain, { kind: "staged" })).rejects.toThrow(
        /git rev-parse failed/,
      );
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("collects only changed files under the given paths, with the usual rules", async () => {
    await files({
      "a.py": "a = 2\n",
      "sub/s.py": "s = 2\n",
      "notes.md": "changed\n",
      ".env": "TOKEN=1\n",
    });
    const changed = await listChangedFiles(repo, { kind: "diff", ref: "base" });
    const everything = await collectFiles({
      rootDir: repo,
      cwd: repo,
      paths: ["."],
      config: { include: ["**/*"], exclude: [] },
      adapters: defaultAdapters,
      globalGitIgnore: false,
      changedOnly: changed.paths,
    });
    expect(everything.files.map((file) => file.path)).toEqual([
      "a.py",
      "sub/s.py",
    ]);
    // The secret file is reported; the unsupported README-like file isn't.
    expect(everything.skipped).toEqual([
      expect.objectContaining({ path: ".env", kind: "sensitive" }),
    ]);

    const underSub = await collectFiles({
      rootDir: repo,
      cwd: repo,
      paths: ["sub"],
      config: { include: ["**/*"], exclude: [] },
      adapters: defaultAdapters,
      globalGitIgnore: false,
      changedOnly: changed.paths,
    });
    expect(underSub.files.map((file) => file.path)).toEqual(["sub/s.py"]);
  });
});
