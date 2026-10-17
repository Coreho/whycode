// `whycode check`: a dry run. It collects the files, runs the pipeline on
// each and prints a verdict and what would change; nothing is written. The
// exit code is 1 when any file would change or had its comments discarded,
// so CI can use it as a gate, and 2 when a file could not be processed (e.g.
// the AI call failed), so a failure never passes.
import type { ChangeScope, ConfigOverrides } from "@whycode/core";
import { resolve } from "node:path";
import { capturePlanFile, savePlan } from "./saved-plan.js";
import type { SavedFile } from "./saved-plan.js";
import { ReviewState } from "./review-state.js";
import { fileVerdict } from "@whycode/core";
import { forEachInOrder } from "./in-order.js";
import type { CliIo } from "./io.js";
import type { CheckSummary, Paint, Skip } from "./report.js";
import {
  painter,
  renderFailures,
  renderFileResult,
  renderSkips,
  renderSummary,
  renderVerdict,
} from "./report.js";
import type { CommandDeps, FileOutcome } from "./run.js";
import {
  describeRun,
  EXIT_CODES,
  prepareRun,
  processCollectedFile,
} from "./run.js";

export async function runCheck(
  paths: readonly string[],
  overrides: ConfigOverrides,
  io: CliIo,
  deps: CommandDeps,
  scope?: ChangeScope,
  planPath?: string,
  reviewStatePath?: string,
  refresh = false,
): Promise<number> {
  // check only ever runs safe mode; refactor mode belongs to `fix --refactor`.
  const run = await prepareRun(
    paths,
    { ...overrides, mode: "safe" },
    io,
    deps,
    scope,
  );
  if (run === undefined) return EXIT_CODES.error;

  const report = new CheckReport(io, painter(io.color));
  report.addSkips(run.skips);
  const entries: SavedFile[] = [];
  const state =
    reviewStatePath === undefined
      ? undefined
      : await ReviewState.open(
          resolve(io.cwd, reviewStatePath),
          run.rootDir,
          run.config,
          deps.adapters,
        );
  const cached = new Map<string, FileOutcome>();
  if (state && !refresh)
    for (const file of run.files) {
      const outcome = await state.lookup(file);
      if (outcome) cached.set(file.path, outcome);
    }
  if (run.files.length > 0) {
    const provider =
      cached.size < run.files.length
        ? deps.createProvider(run.config, io)
        : undefined;
    if (provider)
      io.stderr(
        `Checking ${describeRun(run.files.length, provider, run.config)}...\n`,
      );
    await forEachInOrder(
      run.files,
      deps.concurrency,
      async (file) => {
        const reused = cached.get(file.path);
        if (reused) return reused;
        if (!provider) throw new Error("Missing provider for unreviewed file.");
        const pipelineDeps = { provider, adapters: deps.adapters };
        if (planPath === undefined)
          return processCollectedFile(file, run.config, pipelineDeps);
        const captured = await capturePlanFile(file, run.config, pipelineDeps);
        if (captured.entry) entries.push(captured.entry);
        return captured.outcome;
      },
      (outcome) => report.add(state?.filterRejected(outcome) ?? outcome),
    );
  }
  const exitCode = report.finish();
  if (planPath !== undefined && exitCode !== EXIT_CODES.error) {
    await savePlan(
      resolve(io.cwd, planPath),
      run,
      overrides,
      entries.sort((a, b) => a.path.localeCompare(b.path)),
    );
    io.stdout(
      `Saved review plan: ${planPath}. Apply with whycode fix --plan <saved plan> (no model request).\n`,
    );
  }
  return exitCode;
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
    discarded: 0,
    suggestions: 0,
  };

  constructor(
    private readonly io: CliIo,
    private readonly paint: Paint,
  ) {}

  addSkips(skips: readonly Skip[]): void {
    this.skips.push(...skips);
  }

  add(outcome: FileOutcome): void {
    if ("skip" in outcome) return this.addSkips([outcome.skip]);
    const { result } = outcome;
    const verdict = fileVerdict(result);
    this.io.stdout(renderVerdict(result.path, verdict, this.paint));
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
    if (verdict.kind === "discarded") this.summary.discarded += 1;
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
    // Discarded comments need a look too, so they never pass as clean.
    const needsAttention =
      this.summary.changed > 0 || this.summary.discarded > 0;
    return needsAttention ? EXIT_CODES.changes : EXIT_CODES.clean;
  }
}
