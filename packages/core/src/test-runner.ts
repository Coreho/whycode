// Runs the project's test command against a refactored file. The pipeline
// itself never touches the disk, so front-ends pass a TestRunner in; this
// module's default runner puts the rewritten file in place for the duration
// of the test command and always restores the original bytes afterwards,
// also when WhyCode is interrupted (Ctrl+C, a closed terminal) meanwhile.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { constants } from "node:os";
import { resolve } from "node:path";

export interface TestRunRequest {
  /** The file's path as given to processFile, relative to the runner's root. */
  path: string;
  /** The rewritten file, with the original line endings. */
  code: string;
  /** The configured testCommand, run through the shell. */
  command: string;
}

export interface TestOutcome {
  command: string;
  passed: boolean;
  /** -1 when the command was stopped, e.g. by the timeout. */
  exitCode: number;
  /** The end of the combined stdout and stderr, for the report. */
  output: string;
}

export type TestRunner = (request: TestRunRequest) => Promise<TestOutcome>;

export interface FileSwapTestRunnerOptions {
  /** Directory the command runs in and paths are resolved against. */
  rootDir: string;
  /** Test commands that run longer than this are stopped and count as failed. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Keep only the end of long test output; failures are usually reported last. */
const MAX_OUTPUT_CHARS = 4_000;

/**
 * Writes the rewritten file over the original, runs the test command, then
 * restores the original exactly, even if the command fails or throws. Run one
 * file at a time: the tests see the whole project.
 */
export function createFileSwapTestRunner(
  options: FileSwapTestRunnerOptions,
): TestRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async ({ path, code, command }) => {
    const filePath = resolve(options.rootDir, path);
    const original = await readFile(filePath);
    const stopGuarding = restoreOnSignals(filePath, original, (code) =>
      process.exit(code),
    );
    try {
      await writeFile(filePath, code, "utf8");
      return await runShellCommand(command, options.rootDir, timeoutMs);
    } finally {
      stopGuarding();
      await writeFile(filePath, original);
    }
  };
}

const RESTORE_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * While the rewrite is in place, a signal that would end WhyCode first puts
 * the original file back, then exits with the usual 128 + signal number.
 * Returns a function that removes the guard. Exported for tests.
 */
export function restoreOnSignals(
  filePath: string,
  original: Buffer,
  exit: (code: number) => void,
): () => void {
  const restoreAndExit = (signal: NodeJS.Signals) => {
    writeFileSync(filePath, original);
    exit(128 + (constants.signals[signal] ?? 1));
  };
  for (const signal of RESTORE_SIGNALS) process.once(signal, restoreAndExit);
  return () => {
    for (const signal of RESTORE_SIGNALS) process.off(signal, restoreAndExit);
  };
}

function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<TestOutcome> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      timeout: timeoutMs,
      windowsHide: true,
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolvePromise({
        command,
        passed: exitCode === 0,
        exitCode: exitCode ?? -1,
        output,
      });
    });
  });
}
