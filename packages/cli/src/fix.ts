// `whycode fix`: the only command that writes files. Every changed file is
// shown as a diff and written only when accepted (or with --yes in safe
// mode). Suggested rewrites of existing comments are offered one at a time
// and never applied automatically, not even with --yes.
import type {
  ChangeScope,
  ConfigOverrides,
  ExistingCommentSuggestion,
  FileResult,
  LanguageAdapter,
  PipelineDeps,
} from "@whycode/core";
import {
  findProjectRoot,
  applyCommentSuggestions,
  createFileSwapTestRunner,
  fileVerdict,
  visibleText,
  writeSourceFile,
} from "@whycode/core";
import { relative, resolve, sep } from "node:path";
import { loadPlan, replayPlan } from "./saved-plan.js";
import { ReviewState } from "./review-state.js";
import { forEachInOrder } from "./in-order.js";
import { jsonFile, renderJsonReport, textOnStderr } from "./json-report.js";
import type { CliIo } from "./io.js";
import type { Paint, Skip } from "./report.js";
import {
  painter,
  renderFailures,
  renderFixSummary,
  renderPreview,
  renderSkips,
  renderSuggestion,
  renderVerdict,
} from "./report.js";
import type { CommandDeps, FileOutcome, PreparedRun } from "./run.js";
import {
  describeRun,
  EXIT_CODES,
  prepareRun,
  processCollectedFile,
} from "./run.js";

export interface FixOptions {
  overrides: ConfigOverrides;
  /** Accept every file's changes without asking; refused in refactor mode. */
  yes: boolean;
  /** --staged or --diff: only the files git reports as changed. */
  scope?: ChangeScope;
  plan?: string;
  reviewState?: string;
  refresh?: boolean;
  /** Print one JSON report on stdout; needs `yes`, as stdout can't also hold the review. */
  json?: boolean;
}

const NO_TERMINAL_MESSAGE = `whycode: nothing was written because there is no terminal to review the changes in.
Run "whycode fix" in a terminal, add --yes to accept every change (safe mode only),
or use "whycode check" to see the changes without writing them.
`;

export async function runFix(
  paths: readonly string[],
  options: FixOptions,
  io: CliIo,
  deps: CommandDeps,
): Promise<number> {
  const saved =
    options.plan === undefined
      ? undefined
      : await loadPlan(resolve(io.cwd, options.plan));
  const root = await findProjectRoot(io.cwd);
  const selected =
    paths.length > 0
      ? paths
      : (saved?.files.map((file) => resolve(root, file.path)) ?? []);
  const run = await prepareRun(
    selected,
    { ...saved?.overrides, ...options.overrides },
    io,
    deps,
    options.scope,
  );
  if (run === undefined) return EXIT_CODES.error;
  const refactor = run.config.mode === "refactor";
  if (refactor && options.yes) {
    io.stderr(
      "whycode: --yes can't be used in refactor mode: every rewritten file needs your review.\n",
    );
    return EXIT_CODES.error;
  }
  if (!options.yes && !io.interactive) {
    io.stderr(NO_TERMINAL_MESSAGE);
    return EXIT_CODES.error;
  }

  const paint = painter(io.color);
  // With --json the usual text goes to stderr and stdout carries the report.
  const out = options.json === true ? textOnStderr(io) : io;
  const state =
    options.reviewState === undefined
      ? undefined
      : await ReviewState.open(
          resolve(io.cwd, options.reviewState),
          run.rootDir,
          run.config,
          deps.adapters,
        );
  const session = new FixSession(out, paint, options.yes, deps.adapters, state);
  session.addSkips(run.skips);
  if (run.files.length > 0) {
    if (refactor && !(await confirmRefactor(io, paint, run))) {
      io.stdout("Cancelled. Nothing was changed.\n");
      return EXIT_CODES.clean;
    }
    if (saved) {
      const outcomes = await replayPlan(saved, run, deps.adapters);
      for (const outcome of outcomes) await session.review(outcome);
    } else await reviewAll(run, session, io, deps, state, options.refresh);
  }
  const exitCode = session.finish();
  if (options.scope?.kind === "staged") {
    out.stdout(stagingNote(session.writtenPaths, run.rootDir, io.cwd));
  }
  if (options.json === true) {
    io.stdout(
      renderJsonReport({
        command: "fix",
        exitCode,
        files: session.reviewed.map((result) =>
          jsonFile(result, session.writtenPaths.includes(result.path)),
        ),
        skipped: [...session.skipped],
      }),
    );
  }
  await state?.flush();
  return exitCode;
}

/**
 * fix --staged writes the working copy, so its changes aren't staged yet.
 * Staging stays the user's step; this names the command for the written files.
 */
export function stagingNote(
  written: readonly string[],
  rootDir: string,
  cwd: string,
): string {
  if (written.length === 0) return "";
  const paths = written.map((path) =>
    shellQuote(relative(cwd, resolve(rootDir, path)).split(sep).join("/")),
  );
  return `\nThe written changes are not staged yet. To commit them, stage them:\n  git add -- ${paths.join(" ")}\n`;
}

/** Quotes a path for a POSIX shell when it has characters a shell treats specially. */
function shellQuote(path: string): string {
  return /^[\w./@+-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

async function confirmRefactor(
  io: CliIo,
  paint: Paint,
  run: PreparedRun,
): Promise<boolean> {
  io.stdout(
    `${paint(["bold", "red"], "Refactor mode rewrites your code, so its logic WILL change.")}
The AI may restructure, rename and simplify; nothing checks that behavior is
preserved except your tests and your review.
${describeTestCommand(run.config.testCommand, run.rootDir)}`,
  );
  const answer = await io.ask("Continue? [y/N] ");
  return answer !== undefined && /^y(es)?$/i.test(answer.trim());
}

/**
 * The testCommand comes from the project's .whycoderc.json, which may not be
 * yours (a cloned repository), so the exact shell command is shown before
 * anything runs, with hidden characters made visible.
 */
export function describeTestCommand(
  command: string | null,
  rootDir: string,
): string {
  if (command === null) {
    return "No testCommand is set in .whycoderc.json, so no tests will run.\n";
  }
  return `After each rewrite, this testCommand from .whycoderc.json runs in a shell in ${rootDir}:\n  ${visibleText(command)}\n`;
}

async function reviewAll(
  run: PreparedRun,
  session: FixSession,
  io: CliIo,
  deps: CommandDeps,
  state?: ReviewState,
  refresh = false,
): Promise<void> {
  const cached = new Map<string, FileOutcome>();
  if (state && !refresh)
    for (const file of run.files) {
      const outcome = await state.lookup(file);
      if (outcome) cached.set(file.path, outcome);
    }
  const provider =
    cached.size < run.files.length
      ? deps.createProvider(run.config, io)
      : undefined;
  const runsTests =
    run.config.mode === "refactor" && run.config.testCommand !== null;
  const pipelineDeps: PipelineDeps | undefined =
    provider === undefined
      ? undefined
      : {
          provider,
          adapters: deps.adapters,
          runTests: runsTests
            ? createFileSwapTestRunner({ rootDir: run.rootDir })
            : undefined,
        };
  if (provider)
    io.stderr(
      `Processing ${describeRun(run.files.length, provider, run.config)}...\n`,
    );
  // Tests see the whole project with one rewritten file swapped in, so
  // files must then be processed, reviewed and written one at a time.
  const concurrency = runsTests ? 1 : deps.concurrency;
  const reviewed = new Set<string>();
  await forEachInOrder(
    run.files,
    concurrency,
    (file) =>
      session.stopped
        ? Promise.resolve(undefined)
        : cached.has(file.path)
          ? Promise.resolve(cached.get(file.path))
          : pipelineDeps
            ? processCollectedFile(file, run.config, pipelineDeps)
            : Promise.resolve(undefined),
    async (outcome) => {
      if (outcome === undefined) return;
      reviewed.add(outcome.file.path);
      await session.review(outcome);
    },
  );
  session.markNotReviewed(
    run.files.map((file) => file.path).filter((path) => !reviewed.has(path)),
  );
}

type FileDecision = "accept" | "reject" | "skip" | "quit";

/** Asks about each file, writes what was accepted, and keeps the tallies. */
class FixSession {
  stopped = false;
  private readonly written: string[] = [];
  /** Paths of the files written so far, relative to the project root. */
  get writtenPaths(): readonly string[] {
    return this.written;
  }

  private readonly rejected: string[] = [];
  private readonly skippedByUser: string[] = [];
  private readonly notReviewed: string[] = [];
  private readonly verificationFailed: string[] = [];
  private readonly unchanged: string[] = [];
  private readonly skips: Skip[] = [];
  private readonly failures: Skip[] = [];
  private readonly results: FileResult[] = [];
  /** Every pipeline result reviewed, in order, for the --json report. */
  get reviewed(): readonly FileResult[] {
    return this.results;
  }
  /** Paths passed over, with the reason. */
  get skipped(): readonly Skip[] {
    return this.skips;
  }

  constructor(
    private readonly io: CliIo,
    private readonly paint: Paint,
    private readonly yes: boolean,
    private readonly adapters: readonly LanguageAdapter[],
    private readonly state?: ReviewState,
  ) {}

  addSkips(skips: readonly Skip[]): void {
    this.skips.push(...skips);
  }

  markNotReviewed(paths: readonly string[]): void {
    this.notReviewed.push(...paths);
  }

  async review(outcome: FileOutcome): Promise<void> {
    if (this.stopped) return this.markNotReviewed([outcome.file.path]);
    outcome = this.state?.filterRejected(outcome) ?? outcome;
    if ("skip" in outcome) return this.addSkips([outcome.skip]);
    const { result, file } = outcome;
    this.results.push(result);
    this.io.stdout(renderVerdict(result.path, fileVerdict(result), this.paint));
    if (result.status === "skipped") {
      this.failures.push({
        path: result.path,
        reason: result.skipReason ?? "unknown error",
      });
      return;
    }
    if (result.verification === "failed") {
      this.verificationFailed.push(result.path);
    }
    const hasChanges = result.status === "changed";
    const preview = renderPreview(result, this.paint);
    if (!hasChanges && result.commentSuggestions.length === 0) {
      // Nothing to write, but notes (such as discarded comments) still show.
      if (preview !== "") this.io.stdout(`${preview}\n`);
      this.unchanged.push(result.path);
      await this.state?.remember(file, result, result.originalCode, [], []);
      return;
    }

    this.io.stdout(`${preview}\n`);
    const decision = hasChanges ? await this.decideFile(result.path) : "skip";
    if (decision === "quit") {
      this.io.stdout(`Nothing written to ${result.path}; review stopped.\n`);
      this.stopped = true;
      return this.markNotReviewed([result.path]);
    }
    if (decision === "reject") this.rejected.push(result.path);
    if (decision === "skip" && hasChanges) this.skippedByUser.push(result.path);
    if (decision !== "accept" && hasChanges) this.io.stdout("\n");

    const accepted = decision === "accept";
    const base = accepted ? result.outputCode : result.originalCode;
    const suggestions = await this.chooseSuggestions(
      result,
      accepted || !hasChanges,
    );
    const applied = await this.withSuggestions(
      result.path,
      base,
      suggestions.accepted,
    );
    const finalCode = applied.code;
    let written = true;
    if (finalCode !== result.originalCode) {
      written = await this.write(result, file.absolutePath, finalCode);
    } else if (!hasChanges) {
      this.unchanged.push(result.path);
    }
    if (finalCode === result.originalCode) {
      this.io.stdout(`Nothing written to ${result.path}.\n`);
    }
    const remaining =
      result.commentSuggestions.length -
      applied.applied.length -
      suggestions.rejected.length;
    if (result.commentSuggestions.length > 0) {
      this.io.stdout(
        `Existing-comment corrections: ${written ? applied.applied.length : 0} applied, ${suggestions.rejected.length} rejected, ${written ? remaining : remaining + applied.applied.length} not applied.\n`,
      );
    }
    if (
      written &&
      (decision === "accept" || decision === "reject" || !hasChanges)
    ) {
      const resolved = new Set([...applied.applied, ...suggestions.rejected]);
      await this.state?.remember(
        file,
        result,
        finalCode,
        result.commentSuggestions.filter((s) => !resolved.has(s)),
        suggestions.rejected,
      );
    }
  }

  private async decideFile(path: string): Promise<FileDecision> {
    if (this.yes) return "accept";
    this.io.stdout(
      "This applies the displayed diff. Existing-comment corrections, if any, are separate decisions.\n",
    );
    return this.choose(
      `Apply these changes to ${path}? [y]es / [n]o / [s]kip / [q]uit: `,
      {
        y: "accept",
        n: "reject",
        s: "skip",
        q: "quit",
      },
    );
  }

  /**
   * Suggestions are numbered against the processed code, so they are offered
   * only when that code is kept (or the file had no other changes).
   */
  private async chooseSuggestions(
    result: FileResult,
    offer: boolean,
  ): Promise<{
    accepted: ExistingCommentSuggestion[];
    rejected: ExistingCommentSuggestion[];
  }> {
    const choices: {
      accepted: ExistingCommentSuggestion[];
      rejected: ExistingCommentSuggestion[];
    } = { accepted: [], rejected: [] };
    const suggestions = result.commentSuggestions;
    if (suggestions.length === 0) return choices;
    if (this.yes) {
      this.io.stdout(
        `Not applied: ${suggestions.length} suggested rewrite(s) of existing comments in ${result.path}. --yes never edits existing comments; run without --yes to review them.\n\n`,
      );
      return choices;
    }
    if (!offer) {
      this.io.stdout(
        `Not offered: ${suggestions.length} suggested rewrite(s) of existing comments, because the changes to ${result.path} were not applied.\n\n`,
      );
      return choices;
    }
    for (const [index, suggestion] of suggestions.entries()) {
      const position = { index: index + 1, total: suggestions.length };
      this.io.stdout(
        renderSuggestion(result.path, suggestion, position, this.paint),
      );
      const answer = await this.choose(
        "Apply this suggestion? [y]es / [n]o / [q]uit: ",
        {
          y: "accept",
          n: "reject",
          q: "quit",
        },
      );
      if (answer === "accept") choices.accepted.push(suggestion);
      if (answer === "reject") choices.rejected.push(suggestion);
      if (answer === "quit") {
        this.stopped = true;
        break;
      }
    }
    return choices;
  }

  private async withSuggestions(
    path: string,
    code: string,
    suggestions: readonly ExistingCommentSuggestion[],
  ): Promise<Awaited<ReturnType<typeof applyCommentSuggestions>>> {
    if (suggestions.length === 0) return { code, applied: [], notApplied: [] };
    const applied = await applyCommentSuggestions(
      path,
      code,
      suggestions,
      this.adapters,
    );
    for (const { suggestion, reason } of applied.notApplied) {
      this.io.stdout(
        `Could not apply the suggestion for line ${suggestion.line}: ${reason}.\n`,
      );
    }
    return applied;
  }

  private async write(
    result: FileResult,
    absolutePath: string,
    code: string,
  ): Promise<boolean> {
    const outcome = await writeSourceFile(
      absolutePath,
      code,
      result.originalCode,
    );
    if (outcome.ok) {
      this.written.push(result.path);
      this.io.stdout(`${this.paint("green", `Wrote ${result.path}`)}\n\n`);
      return true;
    } else {
      this.failures.push({
        path: result.path,
        reason: `not written: ${outcome.reason}`,
      });
      return false;
    }
  }

  /** Asks until the answer matches a choice; no answer (Ctrl+C, end of input) quits. */
  private async choose<Choice extends string>(
    question: string,
    choices: Readonly<Record<string, Choice | "quit">>,
  ): Promise<Choice | "quit"> {
    for (;;) {
      const answer = await this.io.ask(question);
      if (answer === undefined) return "quit";
      const choice = choices[answer.trim().toLowerCase().charAt(0)];
      if (choice !== undefined && answer.trim() !== "") return choice;
    }
  }

  finish(): number {
    const sections = [
      renderSkips(this.skips, this.paint),
      renderFailures(this.failures, this.paint),
      renderFixSummary(
        [
          { label: "written", paths: this.written },
          { label: "rejected", paths: this.rejected },
          { label: "skipped", paths: this.skippedByUser },
          { label: "not reviewed (you quit)", paths: this.notReviewed },
          {
            label: "verification failed, so only formatting was offered",
            paths: this.verificationFailed,
          },
          { label: "unchanged", paths: this.unchanged },
        ],
        this.paint,
      ),
    ];
    this.io.stdout(sections.filter((text) => text !== "").join("\n"));
    return this.failures.length > 0 ? EXIT_CODES.error : EXIT_CODES.clean;
  }
}
