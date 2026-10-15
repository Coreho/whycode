// `whycode check`: a dry run. It collects the files, runs the pipeline on
// each and prints what would change; nothing is written. The exit code is 1
// when any file would change, so CI can use it as a gate, and 2 when a file
// could not be processed (e.g. the AI call failed), so a failure never passes.
import type {
  AIProvider,
  CollectedFile,
  ConfigOverrides,
  FileResult,
  LanguageAdapter,
  WhycodeConfig,
} from "@whycode/core";
import {
  collectFiles,
  findProjectRoot,
  loadConfig,
  processFile,
  readSourceFile,
} from "@whycode/core";
import { forEachInOrder } from "./in-order.js";
import type { CliIo } from "./io.js";
import type { CheckSummary, Paint, Skip } from "./report.js";
import {
  painter,
  renderFailures,
  renderFileResult,
  renderSkips,
  renderSummary,
} from "./report.js";

export interface CommandDeps {
  adapters: readonly LanguageAdapter[];
  createProvider: (config: WhycodeConfig, io: CliIo) => AIProvider;
  /** Files processed at the same time; each one is an AI request. */
  concurrency: number;
}

export const EXIT_CODES = { clean: 0, changes: 1, error: 2 } as const;

export async function runCheck(
  paths: readonly string[],
  overrides: ConfigOverrides,
  io: CliIo,
  deps: CommandDeps,
): Promise<number> {
  const rootDir = await findProjectRoot(io.cwd);
  // Refactor mode only runs when asked for with --refactor.
  const config = await loadConfig(rootDir, { ...overrides, mode: "safe" });
  const collection = await collectFiles({
    rootDir,
    cwd: io.cwd,
    paths,
    config,
    adapters: deps.adapters,
  });

  // A mistyped path is an error, not a quiet skip: stop before any AI call.
  const badPaths = collection.skipped.filter(
    (skip) => skip.kind === "missing" || skip.kind === "outside-root",
  );
  if (badPaths.length > 0) {
    for (const bad of badPaths)
      io.stderr(`whycode: ${bad.path}: ${bad.reason}\n`);
    return EXIT_CODES.error;
  }

  const paint = painter(io.color);
  const report = new CheckReport(io, paint);
  report.addSkips(collection.skipped);
  if (collection.files.length > 0) {
    const provider = deps.createProvider(config, io);
    io.stderr(
      `Checking ${collection.files.length} file(s) with ${provider.name} (${config.model}, ${config.commentLevel} comments)...\n`,
    );
    await forEachInOrder(
      collection.files,
      deps.concurrency,
      (file) => checkFile(file, config, provider, deps.adapters),
      (outcome) => report.add(outcome),
    );
  }
  return report.finish();
}

type FileOutcome = { result: FileResult } | { skip: Skip };

async function checkFile(
  file: CollectedFile,
  config: WhycodeConfig,
  provider: AIProvider,
  adapters: readonly LanguageAdapter[],
): Promise<FileOutcome> {
  try {
    const source = await readSourceFile(file.absolutePath);
    if (!source.ok) return { skip: { path: file.path, reason: source.reason } };
    const input = {
      path: file.path,
      absolutePath: file.absolutePath,
      code: source.code,
    };
    return { result: await processFile(input, config, { provider, adapters }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      skip: { path: file.path, reason: `could not be read: ${message}` },
    };
  }
}

/** Prints each file's report as it arrives and keeps the totals. */
class CheckReport {
  private readonly skips: Skip[] = [];
  private readonly failures: Skip[] = [];
  private readonly summary: CheckSummary = {
    changed: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    suggestions: 0,
  };

  constructor(
    private readonly io: CliIo,
    private readonly paint: Paint,
  ) {}

  addSkips(skips: readonly Skip[]): void {
    this.skips.push(...skips.map(({ path, reason }) => ({ path, reason })));
  }

  add(outcome: FileOutcome): void {
    if ("skip" in outcome) return this.addSkips([outcome.skip]);
    const { result } = outcome;
    // Collection already filtered out what the pipeline would refuse, so a
    // file it skips is one that failed, e.g. because the AI call did.
    if (result.status === "skipped") {
      this.failures.push({
        path: result.path,
        reason: result.skipReason ?? "unknown error",
      });
      return;
    }
    this.summary[result.status] += 1;
    this.summary.suggestions += result.commentSuggestions.length;
    const text = renderFileResult(result, this.paint);
    if (text !== "") this.io.stdout(`${text}\n`);
  }

  finish(): number {
    this.summary.skipped = this.skips.length;
    this.summary.failed = this.failures.length;
    const sections = [
      renderSkips(this.skips, this.paint),
      renderFailures(this.failures, this.paint),
    ];
    for (const text of sections) {
      if (text !== "") this.io.stdout(`${text}\n`);
    }
    this.io.stdout(renderSummary(this.summary, this.paint));
    if (this.summary.failed > 0) return EXIT_CODES.error;
    return this.summary.changed > 0 ? EXIT_CODES.changes : EXIT_CODES.clean;
  }
}
