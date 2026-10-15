// Tests for the default test runner with real shell commands: the rewrite is
// in place while the command runs, and the original file always comes back.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileSwapTestRunner, restoreOnSignals } from "./test-runner.js";

const ORIGINAL = "original\r\n";
// Exits 0 only if app.txt holds the rewrite while the command runs.
const CHECK_REWRITE = `node -e "process.exit(require('fs').readFileSync('app.txt','utf8')==='rewritten'?0:1)"`;

describe("createFileSwapTestRunner", () => {
  let rootDir = "";
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "whycode-tests-"));
    await writeFile(join(rootDir, "app.txt"), ORIGINAL);
  });
  afterEach(() => rm(rootDir, { recursive: true, force: true }));

  const runner = () => createFileSwapTestRunner({ rootDir });
  const fileContents = () => readFile(join(rootDir, "app.txt"), "utf8");

  it("runs the command against the rewrite, then restores the original", async () => {
    const outcome = await runner()({
      path: "app.txt",
      code: "rewritten",
      command: CHECK_REWRITE,
    });
    expect(outcome).toMatchObject({ passed: true, exitCode: 0 });
    expect(await fileContents()).toBe(ORIGINAL);
  });

  it("reports a failing command with its exit code and output", async () => {
    const outcome = await runner()({
      path: "app.txt",
      code: "rewritten",
      command: `node -e "console.log('2 tests failed'); process.exit(3)"`,
    });
    expect(outcome).toMatchObject({ passed: false, exitCode: 3 });
    expect(outcome.output).toContain("2 tests failed");
    expect(await fileContents()).toBe(ORIGINAL);
  });

  it("fails without creating anything when the file doesn't exist", async () => {
    await expect(
      runner()({ path: "missing.txt", code: "x", command: "echo hi" }),
    ).rejects.toThrow(/ENOENT/);
    await expect(readFile(join(rootDir, "missing.txt"))).rejects.toThrow();
  });
});

describe("restoreOnSignals", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "whycode-signal-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("puts the original back and exits when interrupted", async () => {
    const path = join(dir, "app.py");
    await writeFile(path, "rewritten\n");
    const exitCodes: number[] = [];
    const stop = restoreOnSignals(path, Buffer.from("original\n"), (code) =>
      exitCodes.push(code),
    );
    try {
      process.emit("SIGINT", "SIGINT");
    } finally {
      stop();
    }
    expect(await readFile(path, "utf8")).toBe("original\n");
    expect(exitCodes).toEqual([130]);
  });

  it("stops guarding once the test command is done", async () => {
    const path = join(dir, "app.py");
    await writeFile(path, "kept\n");
    const before = process.listenerCount("SIGTERM");
    const stop = restoreOnSignals(path, Buffer.from("original\n"), () => {});
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    stop();
    expect(process.listenerCount("SIGTERM")).toBe(before);
    expect(await readFile(path, "utf8")).toBe("kept\n");
  });
});
