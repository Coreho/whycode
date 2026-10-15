// Turns the paths a user names (files or directories) into the list of
// files a WhyCode run may read. This is where the privacy rules are applied
// first: files git ignores and files that may hold secrets are never
// collected, so no front-end can read them or send them to an AI.
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";
import type { WhycodeConfig } from "../config.js";
import type { LanguageAdapter } from "../languages/adapter.js";
import { findAdapterForPath } from "../languages/adapter.js";
import { findCommentOnlyLanguage } from "../languages/fallback.js";
import { isSensitivePath } from "../privacy.js";
import { GitIgnoreRules } from "./gitignore.js";

export interface CollectOptions {
  /** Absolute project root: config globs and .gitignore files are relative to it. */
  rootDir: string;
  /** Files or directories as the user typed them, relative to `cwd` or absolute. */
  paths: readonly string[];
  /** Directory the paths are relative to. Defaults to process.cwd(). */
  cwd?: string;
  config: Pick<WhycodeConfig, "include" | "exclude">;
  /** Languages WhyCode can process; directory walks keep only these files. */
  adapters: readonly LanguageAdapter[];
  /** Larger files are skipped. Defaults to 1 MB. */
  maxFileBytes?: number;
}

export interface CollectedFile {
  /** Relative to the root with forward slashes, e.g. "src/app.py". */
  path: string;
  absolutePath: string;
}

export type SkipKind =
  | "missing"
  | "outside-root"
  | "symlink"
  | "git-internal"
  | "sensitive"
  | "gitignored"
  | "unsupported"
  | "not-included"
  | "excluded"
  | "too-large";

export interface SkippedPath {
  /** Root-relative path; directories end with "/". */
  path: string;
  kind: SkipKind;
  reason: string;
}

export interface FileCollection {
  files: CollectedFile[];
  skipped: SkippedPath[];
}

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

const SKIP_REASONS: Readonly<Record<SkipKind, string>> = {
  missing: "no such file or directory",
  "outside-root": "outside the project root",
  symlink: "symbolic links are not followed",
  "git-internal": "inside the .git directory",
  sensitive:
    "may hold secrets (env, key or credentials file), so it is never read",
  gitignored: "ignored by .gitignore",
  unsupported: "unsupported file type",
  "not-included": 'not matched by "include" in .whycoderc.json',
  excluded: 'matched by "exclude" in .whycoderc.json',
  "too-large": "larger than 1 MB",
};

/** Collects the files under `paths` that WhyCode may read, and why others were skipped. */
export async function collectFiles(
  options: CollectOptions,
): Promise<FileCollection> {
  const collector = new Collector(options);
  for (const path of options.paths) await collector.addUserPath(path);
  return collector.result();
}

class Collector {
  private readonly files = new Map<string, CollectedFile>();
  private readonly skipped = new Map<string, SkippedPath>();
  private readonly gitIgnore: GitIgnoreRules;
  private readonly isIncluded: (path: string) => boolean;
  private readonly isExcluded: (path: string) => boolean;
  private readonly isExcludedDir: (path: string) => boolean;

  constructor(private readonly options: CollectOptions) {
    this.gitIgnore = new GitIgnoreRules(options.rootDir);
    this.isIncluded = globMatcher(options.config.include);
    this.isExcluded = globMatcher(options.config.exclude);
    this.isExcludedDir = globMatcher(
      wholeDirectoryPrefixes(options.config.exclude),
    );
  }

  result(): FileCollection {
    return {
      files: [...this.files.values()],
      skipped: [...this.skipped.values()],
    };
  }

  async addUserPath(userPath: string): Promise<void> {
    const absolutePath = resolve(this.options.cwd ?? process.cwd(), userPath);
    const fromRoot = relative(this.options.rootDir, absolutePath);
    if (isOutside(fromRoot)) {
      return this.skip(userPath, "outside-root");
    }
    const relPath = fromRoot.split(sep).join("/");
    const stats = await lstatOrUndefined(absolutePath);
    if (stats === undefined) return this.skip(userPath, "missing");
    if (stats.isSymbolicLink()) return this.skip(relPath, "symlink");
    if (isInsideGitDir(relPath)) return this.skip(relPath, "git-internal");
    if (stats.isDirectory()) {
      const problem = await this.directoryProblem(relPath);
      return problem === undefined
        ? this.walk(relPath)
        : this.skip(`${relPath}/`, problem);
    }
    if (stats.isFile()) await this.addFile(relPath, stats, true);
  }

  private async walk(dir: string): Promise<void> {
    const entries = await readdir(resolve(this.options.rootDir, dir), {
      withFileTypes: true,
    });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      await this.addWalkedEntry(
        dir === "" ? entry.name : `${dir}/${entry.name}`,
        entry,
      );
    }
  }

  /** Symlinks and .git are passed over quietly; they are never project code. */
  private async addWalkedEntry(relPath: string, entry: Dirent): Promise<void> {
    if (entry.isDirectory()) {
      if (entry.name === ".git") return;
      const problem = await this.directoryProblem(relPath);
      if (problem === undefined) return this.walk(relPath);
      return this.skip(`${relPath}/`, problem);
    }
    if (entry.isFile()) {
      // Only files WhyCode can process are interesting enough to report.
      if (!isSensitivePath(relPath) && !this.isSupported(relPath)) return;
      const stats = await lstat(resolve(this.options.rootDir, relPath));
      await this.addFile(relPath, stats, false);
    }
  }

  private async directoryProblem(
    relPath: string,
  ): Promise<SkipKind | undefined> {
    if (await this.gitIgnore.isIgnored(relPath, true)) return "gitignored";
    if (relPath !== "" && this.isExcludedDir(relPath)) return "excluded";
    return undefined;
  }

  /** Applies the privacy checks first, then the config globs and size limit. */
  private async addFile(
    relPath: string,
    stats: Stats,
    namedByUser: boolean,
  ): Promise<void> {
    if (this.files.has(relPath)) return;
    const problem = await this.fileProblem(relPath, stats, namedByUser);
    if (problem !== undefined) return this.skip(relPath, problem);
    this.files.set(relPath, {
      path: relPath,
      absolutePath: resolve(this.options.rootDir, relPath),
    });
  }

  private async fileProblem(
    relPath: string,
    stats: Stats,
    namedByUser: boolean,
  ): Promise<SkipKind | undefined> {
    if (isSensitivePath(relPath)) return "sensitive";
    if (await this.gitIgnore.isIgnored(relPath, false)) return "gitignored";
    if (namedByUser && !this.isSupported(relPath)) return "unsupported";
    if (!this.isIncluded(relPath)) return "not-included";
    if (this.isExcluded(relPath)) return "excluded";
    const maxBytes = this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (stats.size > maxBytes) return "too-large";
    return undefined;
  }

  private isSupported(relPath: string): boolean {
    return (
      findAdapterForPath(relPath, this.options.adapters) !== undefined ||
      findCommentOnlyLanguage(relPath) !== undefined
    );
  }

  private skip(path: string, kind: SkipKind): void {
    if (!this.skipped.has(path)) {
      this.skipped.set(path, { path, kind, reason: SKIP_REASONS[kind] });
    }
  }
}

/** Matches root-relative paths; dot: true so "**" also covers dotfiles. */
function globMatcher(globs: readonly string[]): (path: string) => boolean {
  if (globs.length === 0) return () => false;
  const matcher = picomatch([...globs], { dot: true, windows: false });
  return (path) => matcher(path);
}

/**
 * "dist/**" excludes everything under any directory matching "dist", so such
 * directories need not be walked at all. Other patterns can't skip a directory.
 */
function wholeDirectoryPrefixes(globs: readonly string[]): string[] {
  return globs
    .filter((glob) => glob.endsWith("/**") && glob.length > 3)
    .map((glob) => glob.slice(0, -3));
}

/** True when a path relative to the root leads out of it (or to another drive). */
function isOutside(fromRoot: string): boolean {
  return (
    fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)
  );
}

function isInsideGitDir(relPath: string): boolean {
  return relPath === ".git" || relPath.startsWith(".git/");
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}
