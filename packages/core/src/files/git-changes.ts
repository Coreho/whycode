// Asks git which files changed, so a run can cover only those: the staged
// files, or everything that differs from where the branch left a base ref
// (committed, uncommitted and new untracked files), as a pull request would
// show it. Deleted files are left out, and renamed files appear under their
// new name.
import { isAbsolute, relative, resolve, sep } from "node:path";
import { runProcess } from "../process.js";

export type ChangeScope =
  | { kind: "staged" }
  /** Changes since the branch left `ref` (via merge-base), e.g. "origin/main". */
  | { kind: "diff"; ref: string };

export interface ChangedFiles {
  /** Changed files relative to the repository root, with forward slashes. */
  paths: string[];
  /** Files with both staged and unstaged changes; writing them would mix the two. */
  partiallyStaged: Set<string>;
}

export class GitChangesError extends Error {
  override name = "GitChangesError";
}

/** Changed files in the git repository whose top folder is `rootDir`. */
export async function listChangedFiles(
  rootDir: string,
  scope: ChangeScope,
): Promise<ChangedFiles> {
  const git = (...args: string[]) => runGit(rootDir, args);
  const topLevel = (await git("rev-parse", "--show-toplevel")).trim();
  // git names files from the repository's top folder; the project root may
  // be a folder inside it.
  const fromRoot = (output: string) =>
    splitNul(output).flatMap((path) => {
      const relPath = relative(rootDir, resolve(topLevel, path));
      const outside =
        relPath === ".." ||
        relPath.startsWith(`..${sep}`) ||
        isAbsolute(relPath);
      return outside ? [] : [relPath.split(sep).join("/")];
    });
  const staged = fromRoot(
    await git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"),
  );
  const unstaged = new Set(
    fromRoot(await git("diff", "--name-only", "--diff-filter=ACMR", "-z")),
  );
  const partiallyStaged = new Set(staged.filter((path) => unstaged.has(path)));
  if (scope.kind === "staged") return { paths: staged, partiallyStaged };

  const base = (await git("merge-base", scope.ref, "HEAD")).trim();
  const changed = fromRoot(
    await git("diff", "--name-only", "--diff-filter=ACMR", "-z", base),
  );
  const untracked = fromRoot(
    await git(
      "ls-files",
      "--others",
      "--exclude-standard",
      "--full-name",
      "-z",
    ),
  );
  return { paths: unique([...changed, ...untracked]), partiallyStaged };
}

/** Runs git in the repository and returns its output, or throws its error. */
async function runGit(
  rootDir: string,
  args: readonly string[],
): Promise<string> {
  const result = await runProcess("git", ["-C", rootDir, ...args], "");
  if (result.kind === "not-found") {
    throw new GitChangesError("git is not installed or not on PATH.");
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split("\n")[0] ?? "";
    throw new GitChangesError(`git ${args[0] ?? ""} failed: ${detail}`);
  }
  return result.stdout;
}

/** git -z output: paths separated by NUL bytes, so any file name is safe. */
function splitNul(output: string): string[] {
  return output.split("\0").filter((path) => path !== "");
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort();
}
