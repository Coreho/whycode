// Answers "does git ignore this path?" the way git does: .git/info/exclude
// and every .gitignore from the project root down to the path's directory,
// with deeper files overriding shallower ones. A path inside an ignored
// directory is ignored too, since git never looks inside such a directory.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ignore } from "ignore";
import ignore from "ignore";

export class GitIgnoreRules {
  /** Parsed ignore files per directory ("" is the root), loaded on first use. */
  private readonly rulesByDir = new Map<string, Promise<Ignore[]>>();
  /** Memoized answers for directories, which every path below them asks about. */
  private readonly ignoredDirs = new Map<string, Promise<boolean>>();

  constructor(private readonly rootDir: string) {}

  /**
   * True if git ignores the path. `relPath` is relative to the root, uses
   * forward slashes and has no leading "./"; "" (the root) is never ignored.
   */
  async isIgnored(relPath: string, isDirectory: boolean): Promise<boolean> {
    if (relPath === "") return false;
    const parent = parentDir(relPath);
    if (parent !== "" && (await this.isIgnoredDir(parent))) return true;
    return this.matchesRules(relPath, isDirectory);
  }

  private isIgnoredDir(relPath: string): Promise<boolean> {
    let answer = this.ignoredDirs.get(relPath);
    if (answer === undefined) {
      answer = this.isIgnored(relPath, true);
      this.ignoredDirs.set(relPath, answer);
    }
    return answer;
  }

  /** Applies the rules of each ancestor directory in turn; the last match wins. */
  private async matchesRules(
    relPath: string,
    isDirectory: boolean,
  ): Promise<boolean> {
    let ignored = false;
    for (const dir of ancestorDirs(relPath)) {
      const pathFromDir = dir === "" ? relPath : relPath.slice(dir.length + 1);
      const candidate = isDirectory ? `${pathFromDir}/` : pathFromDir;
      for (const rules of await this.rulesFor(dir)) {
        const result = rules.test(candidate);
        if (result.ignored) ignored = true;
        else if (result.unignored) ignored = false;
      }
    }
    return ignored;
  }

  private rulesFor(dir: string): Promise<Ignore[]> {
    let rules = this.rulesByDir.get(dir);
    if (rules === undefined) {
      rules = this.loadRules(dir);
      this.rulesByDir.set(dir, rules);
    }
    return rules;
  }

  /** The directory's .gitignore, preceded at the root by .git/info/exclude. */
  private async loadRules(dir: string): Promise<Ignore[]> {
    const files =
      dir === ""
        ? [join(".git", "info", "exclude"), ".gitignore"]
        : [join(dir, ".gitignore")];
    const rules: Ignore[] = [];
    for (const file of files) {
      const text = await readOptional(join(this.rootDir, file));
      if (text !== undefined) rules.push(ignore().add(text));
    }
    return rules;
  }
}

/** "a/b/c.py" -> ["", "a", "a/b"]: the directories whose ignore files apply. */
function ancestorDirs(relPath: string): string[] {
  const segments = relPath.split("/").slice(0, -1);
  return [
    "",
    ...segments.map((_, index) => segments.slice(0, index + 1).join("/")),
  ];
}

function parentDir(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  return slash === -1 ? "" : relPath.slice(0, slash);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    // Missing or unreadable (e.g. .git is a worktree file): no rules here.
    return undefined;
  }
}
