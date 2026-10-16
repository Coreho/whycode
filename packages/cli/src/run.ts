// Steps `check` and `fix` share: find the project root, load the config,
// collect the files (where the privacy rules apply), and run the pipeline on
// one collected file.
import type {
  AIProvider,
  ChangeScope,
  CollectedFile,
  ConfigOverrides,
  FileResult,
  LanguageAdapter,
  PipelineDeps,
  WhycodeConfig,
} from "@whycode/core";
import {
  collectFiles,
  findProjectRoot,
  listChangedFiles,
  loadConfig,
  processFile,
  readSourceFile,
} from "@whycode/core";
import type { CliIo } from "./io.js";
import type { Skip } from "./report.js";

export interface CommandDeps {
  adapters: readonly LanguageAdapter[];
  createProvider: (config: WhycodeConfig, io: CliIo) => AIProvider;
  /** Files processed at the same time; each one is an AI request. */
  concurrency: number;
}

export const EXIT_CODES = { clean: 0, changes: 1, error: 2 } as const;

export interface PreparedRun {
  rootDir: string;
  config: WhycodeConfig;
  files: CollectedFile[];
  /** Paths collection passed over, with the reason. */
  skips: Skip[];
}

const PARTIALLY_STAGED_REASON =
  "has unstaged changes as well as staged ones; stage or stash them first";

/** Loads config and collects files, or prints why the run can't start. */
export async function prepareRun(
  paths: readonly string[],
  overrides: ConfigOverrides,
  io: CliIo,
  deps: CommandDeps,
  scope?: ChangeScope,
): Promise<PreparedRun | undefined> {
  const rootDir = await findProjectRoot(io.cwd);
  const config = await loadConfig(rootDir, overrides);
  // With --staged or --diff, git says which files changed; only those count.
  const changes =
    scope === undefined ? undefined : await listChangedFiles(rootDir, scope);
  const collection = await collectFiles({
    rootDir,
    cwd: io.cwd,
    paths,
    config,
    adapters: deps.adapters,
    changedOnly: changes?.paths,
  });

  // A mistyped path is an error, not a quiet skip: stop before any AI call.
  const badPaths = collection.skipped.filter(
    (skip) => skip.kind === "missing" || skip.kind === "outside-root",
  );
  if (badPaths.length > 0) {
    for (const bad of badPaths) {
      io.stderr(`whycode: ${bad.path}: ${bad.reason}\n`);
    }
    return undefined;
  }

  const skips = collection.skipped.map(({ path, reason }) => ({
    path,
    reason,
  }));
  // With --staged, a file that also has unstaged changes is passed over: its
  // working copy, which WhyCode reads and writes, isn't what will be committed.
  const partial =
    scope?.kind === "staged" ? changes?.partiallyStaged : undefined;
  const isPartial = (file: CollectedFile) => partial?.has(file.path) === true;
  const partialFiles = collection.files.filter(isPartial);
  for (const file of partialFiles) {
    skips.push({ path: file.path, reason: PARTIALLY_STAGED_REASON });
  }
  // A pre-commit hook passes these files unchecked, so say so where hook
  // output shows it, not only in the summary.
  if (partialFiles.length > 0)
    io.stderr(partialStagingWarning(partialFiles.length));
  const files = collection.files.filter((file) => !isPartial(file));
  return { rootDir, config, files, skips };
}

function partialStagingWarning(count: number): string {
  const files =
    count === 1 ? "1 staged file was" : `${count} staged files were`;
  return `whycode: warning: ${files} not checked because of unstaged edits, so what you commit there is unchecked. Stage or stash those edits first.\n`;
}

export type FileOutcome =
  | { file: CollectedFile; result: FileResult }
  | { file: CollectedFile; skip: Skip };

/** Reads one collected file and runs the pipeline on it. Never throws. */
export async function processCollectedFile(
  file: CollectedFile,
  config: WhycodeConfig,
  deps: PipelineDeps,
): Promise<FileOutcome> {
  try {
    const source = await readSourceFile(file.absolutePath);
    if (!source.ok) {
      return { file, skip: { path: file.path, reason: source.reason } };
    }
    const input = {
      path: file.path,
      absolutePath: file.absolutePath,
      code: source.code,
    };
    return { file, result: await processFile(input, config, deps) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      file,
      skip: { path: file.path, reason: `could not be read: ${message}` },
    };
  }
}

export function describeRun(
  fileCount: number,
  provider: AIProvider,
  config: WhycodeConfig,
): string {
  const files = fileCount === 1 ? "1 file" : `${fileCount} files`;
  return `${files} with ${provider.name} (${config.model}, ${config.commentLevel} comments)`;
}
