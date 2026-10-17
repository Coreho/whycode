// Tests for --json: check and fix print one JSON report on stdout, with the
// usual text on stderr, hashes that match the files, and the same exit code.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIRequest } from "@whycode/core";
import {
  commentPlanReply,
  createToyAdapter,
  FakeAIProvider,
} from "@whycode/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import type { CliIo } from "./io.js";
import type { JsonReport } from "./json-report.js";
import type { CommandDeps } from "./run.js";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

describe("--json", () => {
  let root: string;
  let stdout: string;
  let stderr: string;

  const io = (): CliIo => ({
    cwd: root,
    env: {},
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    color: false,
    interactive: false,
    ask: () => Promise.resolve(undefined),
    readStdin: () => Promise.resolve(""),
  });

  // Comments the first line of a.toy and leaves every other file alone.
  const deps = (): CommandDeps => ({
    adapters: [createToyAdapter()],
    createProvider: () =>
      new FakeAIProvider((request: AIRequest) =>
        commentPlanReply({
          insertions: request.user.includes("a.toy")
            ? [{ line: 1, position: "above", text: "Starts the run." }]
            : [],
        }),
      ),
    concurrency: 1,
  });

  const report = () => JSON.parse(stdout) as JsonReport;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "whycode-json-"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "a.toy"), "start\n");
    await writeFile(join(root, "b.toy"), "stop\n");
    await writeFile(join(root, ".env"), "SECRET=1\n");
    stdout = "";
    stderr = "";
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("check prints one report with hashes, verdicts and skips, and the usual text on stderr", async () => {
    const code = await runCli(
      ["check", "a.toy", "b.toy", ".env", "--json"],
      io(),
      deps(),
    );
    expect(code).toBe(1);
    const json = report();
    expect(json).toMatchObject({
      tool: "whycode",
      command: "check",
      exitCode: 1,
    });
    expect(json.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(json.files).toEqual([
      expect.objectContaining({
        path: "a.toy",
        inputSha256: sha256("start\n"),
        outputSha256: sha256("# Starts the run.\nstart\n"),
        verdict: "verified",
        verification: { method: "tokens", outcome: "passed" },
        commentsAdded: 1,
        suggestions: [],
      }),
      expect.objectContaining({
        path: "b.toy",
        inputSha256: sha256("stop\n"),
        outputSha256: sha256("stop\n"),
        verdict: "unchanged",
      }),
    ]);
    expect(json.files[0]).not.toHaveProperty("written");
    expect(json.skipped).toEqual([expect.objectContaining({ path: ".env" })]);
    expect(stderr).toContain("a.toy: 1 comment added");
  });

  it("fix --yes reports what it wrote, with the hash of the file on disk", async () => {
    const code = await runCli(
      ["fix", "a.toy", "b.toy", "--yes", "--json"],
      io(),
      deps(),
    );
    expect(code).toBe(0);
    const written = await readFile(join(root, "a.toy"), "utf8");
    expect(written).toBe("# Starts the run.\nstart\n");
    const [a, b] = report().files;
    expect(a).toMatchObject({
      path: "a.toy",
      written: true,
      inputSha256: sha256("start\n"),
      outputSha256: sha256(written),
    });
    expect(b).toMatchObject({ path: "b.toy", written: false });
    expect(b?.outputSha256).toBe(b?.inputSha256);
  });

  it("fix --json needs --yes, since stdout can't also hold the review", async () => {
    const code = await runCli(["fix", "a.toy", "--json"], io(), deps());
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/--json with fix needs --yes/);
  });
});
