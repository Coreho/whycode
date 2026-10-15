// Answers "does git ignore this path?" the way git does: the user's global
// excludes file, the repository's info/exclude, and every .gitignore from
// the project root down to the path's directory, with later and deeper
// files overriding earlier ones. A path inside an ignored directory is
// ignored too, since git never looks inside such a directory.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Ignore } from "ignore";
import ignore from "ignore";
import { runProcess } from "../process.js";

export class GitIgnoreRules {
  /** Parsed ignore files per directory ("" is the root), loaded on first use. */
  private readonly rulesByDir = new Map<string, Promise<Ignore[]>>();
  /** Memoized answers for directories, which every path below them asks about. */
  private readonly ignoredDirs = new Map<string, Promise<boolean>>();

  /**
   * @param globalExcludesFile the user's global git excludes file, if any
   *   (see findGlobalGitIgnore); its patterns are relative to the root.
   */
  constructor(
    private readonly rootDir: string,
    private readonly globalExcludesFile?: string,
  ) {}

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

  /**
   * The directory's .gitignore. At the root it comes after the global
   * excludes file and info/exclude, which it overrides.
   */
  private async loadRules(dir: string): Promise<Ignore[]> {
    const files =
      dir === ""
        ? [
            ...(this.globalExcludesFile ? [this.globalExcludesFile] : []),
            await infoExcludePath(this.rootDir),
            join(this.rootDir, ".gitignore"),
          ]
        : [join(this.rootDir, dir, ".gitignore")];
    const rules: Ignore[] = [];
    for (const file of files) {
      const text = await readOptional(file);
      if (text !== undefined) rules.push(ignore().add(text));
    }
    return rules;
  }
}

/**
 * Where the repository keeps info/exclude. In a worktree or submodule .git is
 * a file pointing at the real git directory, and a worktree shares the main
 * repository's info/exclude through its "commondir" file.
 */
async function infoExcludePath(rootDir: string): Promise<string> {
  const dotGit = join(rootDir, ".git");
  const pointer = await readOptional(dotGit);
  const target =
    pointer === undefined ? undefined : /^gitdir:\s*(.+)$/m.exec(pointer)?.[1];
  if (target === undefined) return join(dotGit, "info", "exclude");
  const gitDir = resolve(rootDir, target.trim());
  const commonDir = await readOptional(join(gitDir, "commondir"));
  const sharedDir =
    commonDir === undefined ? gitDir : resolve(gitDir, commonDir.trim());
  return join(sharedDir, "info", "exclude");
}

/**
 * The user's global excludes file: git's core.excludesFile setting, or git's
 * default, $XDG_CONFIG_HOME/git/ignore (~/.config/git/ignore).
 */
export async function findGlobalGitIgnore(
  rootDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const configured = await runProcess(
    "git",
    ["-C", rootDir, "config", "--path", "--get", "core.excludesFile"],
    "",
  ).catch(() => undefined);
  const path =
    configured?.kind === "completed" && configured.exitCode === 0
      ? configured.stdout.trim()
      : "";
  if (path !== "") return resolve(rootDir, path);
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "git", "ignore");
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
