// What WhyCode's commands do: collect the chosen files (where the privacy
// rules apply), run the core pipeline on them under a cancellable progress
// notification, then review the results with the user. The editor only runs
// safe mode, which never changes program logic.
import type {
  AIProvider,
  CollectedFile,
  FileResult,
  LanguageAdapter,
  WhycodeConfig,
} from "@whycode/core";
import { fileVerdict, processFile, readSourceFile } from "@whycode/core";
import * as vscode from "vscode";
import type { Env } from "./ai.js";
import { chooseAI } from "./ai.js";
import type { Project } from "./projects.js";
import { prepareRun } from "./projects.js";
import type { ProposalDocuments } from "./proposals.js";
import type { RunTally } from "./report.js";
import { emptyTally, forLog, renderTally, summarize } from "./report.js";
import { ReviewSession } from "./review.js";

type Output = Pick<vscode.OutputChannel, "appendLine" | "show">;

export interface CleanUpDeps {
  output: Output;
  proposals: ProposalDocuments;
  adapters: readonly LanguageAdapter[];
  /** Where API keys are read from: the environment VS Code was started with. */
  env: Env;
}

/** Above this many files WhyCode asks first, since each file is one AI request. */
export const CONFIRM_ABOVE_FILES = 25;
/** Files processed at the same time. */
const CONCURRENCY = 4;

interface Job {
  file: CollectedFile;
  config: WhycodeConfig;
  provider: AIProvider;
}

type Processed =
  | { file: CollectedFile; result: FileResult }
  | { file: CollectedFile; skip: string };

type Log = (line: string) => void;

export async function cleanUp(
  targets: readonly vscode.Uri[],
  deps: CleanUpDeps,
): Promise<void> {
  const paths = targets
    .filter((uri) => uri.scheme === "file")
    .map((uri) => uri.fsPath);
  if (paths.length === 0) {
    void vscode.window.showInformationMessage(
      targets.length === 0
        ? "WhyCode: open a file, or select files or folders in the Explorer, to clean them up."
        : "WhyCode only cleans up files saved on disk.",
    );
    return;
  }
  const log: Log = (line) => deps.output.appendLine(line);
  log(`WhyCode run started ${new Date().toLocaleString()}`);
  try {
    await run(paths, deps, log);
  } catch (error) {
    // Config errors, no model and no key: the message says what to fix.
    const message = error instanceof Error ? error.message : String(error);
    log(`Error: ${forLog(message)}`);
    void vscode.window.showErrorMessage(`WhyCode: ${message}`);
  }
}

async function run(
  paths: readonly string[],
  deps: CleanUpDeps,
  log: Log,
): Promise<void> {
  const tally = emptyTally();
  const prepared = await prepareRun(paths, deps.adapters);
  prepared.notes.forEach(log);
  tally.skipped.push(...prepared.skipped);

  const fileCount = prepared.projects.reduce(
    (count, project) => count + project.files.length,
    0,
  );
  if (fileCount > CONFIRM_ABOVE_FILES && !(await confirmMany(fileCount))) {
    log("Cancelled before any file was sent to the AI.");
    return;
  }
  const processed =
    fileCount === 0
      ? []
      : await processWithProgress(prepared.projects, deps, log);
  if (processed === undefined) {
    log("Cancelled. Nothing was written.");
    void vscode.window.showInformationMessage(
      "WhyCode: cancelled. Nothing was written.",
    );
    return;
  }
  await reviewAll(processed, tally, deps, log);
  finish(tally, deps.output);
}

async function confirmMany(fileCount: number): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    `WhyCode will send ${fileCount} files to an AI model, one request each. Continue?`,
    { modal: true },
    "Continue",
  );
  return answer === "Continue";
}

/** Runs the pipeline on every file; undefined when the user cancelled. */
async function processWithProgress(
  projects: readonly Project[],
  deps: CleanUpDeps,
  log: Log,
): Promise<Processed[] | undefined> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "WhyCode",
      cancellable: true,
    },
    async (progress, token) => {
      const jobs: Job[] = [];
      for (const project of projects.filter((p) => p.files.length > 0)) {
        progress.report({ message: "choosing an AI model..." });
        const ai = await chooseAI(
          project.provider,
          project.config,
          deps.env,
          token,
        );
        log(
          `Cleaning up ${project.files.length} file(s) in ${project.rootDir} with ${ai.description}, ${project.config.commentLevel} comments.`,
        );
        for (const file of project.files) {
          jobs.push({ file, config: project.config, provider: ai.provider });
        }
      }
      let done = 0;
      const processed = await processJobs(jobs, deps.adapters, token, () =>
        progress.report({
          message: `${++done} of ${jobs.length} files`,
          increment: 100 / jobs.length,
        }),
      );
      return token.isCancellationRequested ? undefined : processed;
    },
  );
}

/** Processes a few files at a time, in order, and starts none after cancellation. */
async function processJobs(
  jobs: readonly Job[],
  adapters: readonly LanguageAdapter[],
  token: vscode.CancellationToken,
  onDone: () => void,
): Promise<Processed[]> {
  const results: Processed[] = [];
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < jobs.length; index = next++) {
      const job = jobs[index];
      if (job === undefined || token.isCancellationRequested) return;
      results[index] = await processJob(job, adapters);
      onDone();
    }
  };
  const workerCount = Math.min(CONCURRENCY, jobs.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results.filter((result) => result !== undefined);
}

/** Reads one file and runs the pipeline on it. Never throws. */
async function processJob(
  { file, config, provider }: Job,
  adapters: readonly LanguageAdapter[],
): Promise<Processed> {
  try {
    const source = await readSourceFile(file.absolutePath);
    if (!source.ok) return { file, skip: source.reason };
    const input = {
      path: file.path,
      absolutePath: file.absolutePath,
      code: source.code,
    };
    return {
      file,
      result: await processFile(input, config, { provider, adapters }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { file, skip: `could not be read: ${message}` };
  }
}

async function reviewAll(
  processed: readonly Processed[],
  tally: RunTally,
  deps: CleanUpDeps,
  log: Log,
): Promise<void> {
  const toReview: { file: CollectedFile; result: FileResult }[] = [];
  for (const item of processed) {
    if ("skip" in item) {
      tally.skipped.push({ path: item.file.path, reason: item.skip });
      continue;
    }
    const { result } = item;
    log(`${result.path}: ${forLog(fileVerdict(result).text)}`);
    // Collection already filtered out what the pipeline refuses, so a file
    // it skips is one that failed, e.g. because the AI call did.
    if (result.status === "skipped") {
      tally.failed.push({
        path: result.path,
        reason: result.skipReason ?? "unknown error",
      });
      continue;
    }
    for (const warning of result.warnings) {
      log(`${result.path}: ${forLog(warning)}`);
    }
    if (result.verification === "failed")
      tally.formattingOnly.push(result.path);
    if (result.status === "changed" || result.commentSuggestions.length > 0) {
      toReview.push(item);
    } else {
      tally.unchanged.push(result.path);
    }
  }

  const session = new ReviewSession(tally, deps.proposals, deps.adapters, log);
  for (const [index, { file, result }] of toReview.entries()) {
    if (session.stopped) {
      tally.notReviewed.push(result.path);
    } else {
      const position = { index: index + 1, total: toReview.length };
      await session.review(file, result, position);
    }
  }
}

function finish(tally: RunTally, output: Output): void {
  for (const line of renderTally(tally)) output.appendLine(line);
  const hasReasons = tally.skipped.length + tally.failed.length > 0;
  const message = `WhyCode: ${summarize(tally)}${hasReasons ? " The WhyCode output says why." : ""}`;
  const shown =
    tally.failed.length > 0
      ? vscode.window.showWarningMessage(message, "Show Output")
      : vscode.window.showInformationMessage(message, "Show Output");
  void shown.then((choice) => {
    if (choice === "Show Output") output.show(true);
  });
}
