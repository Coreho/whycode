// Tests for finding the project root: git repository first, then the
// nearest .whycoderc.json, then the starting folder itself.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findProjectRoot } from "./project-root.js";

describe("findProjectRoot", () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "whycode-root-"));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("returns the git repository's top folder from deep inside it", async () => {
    await mkdir(join(base, "repo", ".git"), { recursive: true });
    await mkdir(join(base, "repo", "src", "app"), { recursive: true });
    expect(await findProjectRoot(join(base, "repo", "src", "app"))).toBe(
      join(base, "repo"),
    );
  });

  it("accepts a .git file, as in worktrees and submodules", async () => {
    await mkdir(join(base, "wt", "src"), { recursive: true });
    await writeFile(join(base, "wt", ".git"), "gitdir: elsewhere\n");
    expect(await findProjectRoot(join(base, "wt", "src"))).toBe(
      join(base, "wt"),
    );
  });

  it("prefers the git root over a .whycoderc.json in a subfolder", async () => {
    await mkdir(join(base, "repo", ".git"), { recursive: true });
    await mkdir(join(base, "repo", "pkg"), { recursive: true });
    await writeFile(join(base, "repo", "pkg", ".whycoderc.json"), "{}");
    expect(await findProjectRoot(join(base, "repo", "pkg"))).toBe(
      join(base, "repo"),
    );
  });

  it("falls back to the nearest .whycoderc.json outside a git repository", async () => {
    await mkdir(join(base, "proj", "src"), { recursive: true });
    await writeFile(join(base, "proj", ".whycoderc.json"), "{}");
    const start = join(base, "proj", "src");
    const root = await findProjectRoot(start);
    // Only meaningful when the temp folder isn't itself inside a repository.
    if (root !== start && !root.startsWith(base)) return;
    expect(root).toBe(join(base, "proj"));
  });
});
