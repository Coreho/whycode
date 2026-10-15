// Runs external formatter binaries (ruff, and later gofmt, rustfmt, ...)
// with code on stdin. A missing binary is reported as "not-found" instead of
// thrown, because a missing formatter is only a warning in WhyCode.
import { spawn } from "node:child_process";

export type ProcessResult =
  | { kind: "completed"; exitCode: number; stdout: string; stderr: string }
  | { kind: "not-found" };

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  stdin: string,
) => Promise<ProcessResult>;

/** Formatters that take longer than this are stopped and treated as failed. */
const TIMEOUT_MS = 30_000;

export const runProcess: ProcessRunner = (command, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      timeout: TIMEOUT_MS,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (error) => {
      if (isCommandNotFound(error)) resolve({ kind: "not-found" });
      else reject(error);
    });
    child.on("close", (exitCode, signal) => {
      resolve({
        kind: "completed",
        // A null exit code means the process was killed, e.g. by the timeout.
        exitCode: exitCode ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: signal
          ? `${command} was stopped (${signal}).`
          : Buffer.concat(stderr).toString("utf8"),
      });
    });

    // If the process exits before reading stdin, writing fails with EPIPE.
    // The outcome is reported by the "close" or "error" handler instead.
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin, "utf8");
  });

function isCommandNotFound(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
}
