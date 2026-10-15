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
  applyCommentSuggestions,
  createFileSwapTestRunner,
  fileVerdict,
  writeSourceFile,
} from "@whycode/core";
import { forEachInOrder } from "./in-order.js";
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
  const run = await prepareRun(
    paths,
    options.overrides,
    io,
    deps,
    options.scope,
  );
  if (run === undefined) return EXIT_CODES.error;
  // Writing a partially staged file would overwrite its unstaged edits.
  for (const file of run.files.filter((f) => run.partiallyStaged.has(f.path))) {
    run.skips.push({
      path: file.path,
      reason:
        "has unstaged changes as well as staged ones; stage or stash them first",
    });
  }
  run.files = run.files.filter((file) => !run.partiallyStaged.has(file.path));
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
  const session = new FixSession(io, paint, options.yes, deps.adapters);
  session.addSkips(run.skips);
  if (run.files.length > 0) {
    if (refactor && !(await confirmRefactor(io, paint))) {
      io.stdout("Cancelled. Nothing was changed.\n");
      return EXIT_CODES.clean;
    }
    await reviewAll(run, session, io, deps);
  }
  return session.finish();
}

async function confirmRefactor(io: CliIo, paint: Paint): Promise<boolean> {
  io.stdout(
    `${paint(["bold", "red"], "Refactor mode rewrites your code, so its logic WILL change.")}
The AI may restructure, rename and simplify; nothing checks that behavior is
preserved except your tests (testCommand in .whycoderc.json) and your review.
`,
  );
  const answer = await io.ask("Continue? [y/N] ");
  return answer !== undefined && /^y(es)?$/i.test(answer.trim());
}

async function reviewAll(
  run: PreparedRun,
  session: FixSession,
  io: CliIo,
  deps: CommandDeps,
): Promise<void> {
  const provider = deps.createProvider(run.config, io);
  const runsTests =
    run.config.mode === "refactor" && run.config.testCommand !== null;
  const pipelineDeps: PipelineDeps = {
    provider,
    adapters: deps.adapters,
    runTests: runsTests
      ? createFileSwapTestRunner({ rootDir: run.rootDir })
      : undefined,
  };
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
        : processCollectedFile(file, run.config, pipelineDeps),
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
  private readonly rejected: string[] = [];
  private readonly skippedByUser: string[] = [];
  private readonly notReviewed: string[] = [];
  private readonly verificationFailed: string[] = [];
  private readonly unchanged: string[] = [];
  private readonly skips: Skip[] = [];
  private readonly failures: Skip[] = [];

  constructor(
    private readonly io: CliIo,
    private readonly paint: Paint,
    private readonly yes: boolean,
    private readonly adapters: readonly LanguageAdapter[],
  ) {}

  addSkips(skips: readonly Skip[]): void {
    this.skips.push(...skips);
  }

  markNotReviewed(paths: readonly string[]): void {
    this.notReviewed.push(...paths);
  }

  async review(outcome: FileOutcome): Promise<void> {
    if (this.stopped) return this.markNotReviewed([outcome.file.path]);
    if ("skip" in outcome) return this.addSkips([outcome.skip]);
    const { result, file } = outcome;
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
      return;
    }

    this.io.stdout(`${preview}\n`);
    const decision = hasChanges ? await this.decideFile(result.path) : "skip";
    if (decision === "quit") {
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
    const finalCode = await this.withSuggestions(
      result.path,
      base,
      suggestions,
    );
    if (finalCode !== result.originalCode) {
      await this.write(result, file.absolutePath, finalCode);
    } else if (!hasChanges) {
      this.unchanged.push(result.path);
    }
  }

  private async decideFile(path: string): Promise<FileDecision> {
    if (this.yes) return "accept";
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
  ): Promise<ExistingCommentSuggestion[]> {
    const suggestions = result.commentSuggestions;
    if (suggestions.length === 0) return [];
    if (this.yes) {
      this.io.stdout(
        `Not applied: ${suggestions.length} suggested rewrite(s) of existing comments in ${result.path}. --yes never edits existing comments; run without --yes to review them.\n\n`,
      );
      return [];
    }
    if (!offer) {
      this.io.stdout(
        `Not offered: ${suggestions.length} suggested rewrite(s) of existing comments, because the changes to ${result.path} were not applied.\n\n`,
      );
      return [];
    }
    const accepted: ExistingCommentSuggestion[] = [];
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
      if (answer === "accept") accepted.push(suggestion);
      if (answer === "quit") {
        this.stopped = true;
        break;
      }
    }
    return accepted;
  }

  private async withSuggestions(
    path: string,
    code: string,
    suggestions: readonly ExistingCommentSuggestion[],
  ): Promise<string> {
    if (suggestions.length === 0) return code;
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
    return applied.code;
  }

  private async write(
    result: FileResult,
    absolutePath: string,
    code: string,
  ): Promise<void> {
    const outcome = await writeSourceFile(
      absolutePath,
      code,
      result.originalCode,
    );
    if (outcome.ok) {
      this.written.push(result.path);
      this.io.stdout(`${this.paint("green", `Wrote ${result.path}`)}\n\n`);
    } else {
      this.failures.push({
        path: result.path,
        reason: `not written: ${outcome.reason}`,
      });
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
