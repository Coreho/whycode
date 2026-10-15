// Tests for the default test runner with real shell commands: the rewrite is
// in place while the command runs, and the original file always comes back.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileSwapTestRunner } from "./test-runner.js";

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
