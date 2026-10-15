// Tests for refactor mode in the pipeline, run offline with the fake AI
// provider: the rewrite comes back as a diff, must still parse, is marked as
// logic-changing, and test commands report whether the rewrite passes.
import { describe, expect, it } from "vitest";
import { refactorPlanJsonSchema } from "./ai/refactor-plan.js";
import { resolveConfig } from "./config.js";
import type { LanguageAdapter } from "./languages/adapter.js";
import { createPythonAdapter } from "./languages/python.js";
import type { FileInput, PipelineDeps } from "./pipeline.js";
import { processFile } from "./pipeline.js";
import type { TestRunner, TestRunRequest } from "./test-runner.js";
import { FakeAIProvider } from "./testing/fake-provider.js";
import type { FakeResponse } from "./testing/fake-provider.js";

const refactorConfig = resolveConfig({ mode: "refactor" });
const configWithTests = resolveConfig({
  mode: "refactor",
  testCommand: "npm test",
});
// Without Ruff, so results don't depend on what is installed.
const python = createPythonAdapter({
  runProcess: () => Promise.resolve({ kind: "not-found" }),
});

const original = [
  "def total(items):",
  "    s = 0",
  "    for i in items:",
  "        s = s + i",
  "    return s",
  "",
].join("\n");
const rewrite = [
  "def total(items):",
  "    # Add up the item prices.",
  "    return sum(items)",
  "",
].join("\n");

const refactorReply = (code: string) =>
  JSON.stringify({ code, changes: ["Replaced the loop with sum()"] });

function setup(
  responses: FakeResponse | FakeResponse[],
  options: { adapter?: LanguageAdapter; runTests?: TestRunner } = {},
) {
  const provider = new FakeAIProvider(responses);
  const deps: PipelineDeps = {
    provider,
    adapters: [options.adapter ?? python],
    ...(options.runTests && { runTests: options.runTests }),
  };
  const run = (
    input: FileInput = { path: "cart.py", code: original },
    config = refactorConfig,
  ) => processFile(input, config, deps);
  return { provider, run };
}

function fakeTestRunner(outcome: { passed: boolean } | Error) {
  const requests: TestRunRequest[] = [];
  const runTests: TestRunner = (request) => {
    requests.push(request);
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve({
      command: request.command,
      passed: outcome.passed,
      exitCode: outcome.passed ? 0 : 1,
      output: outcome.passed ? "1 passed" : "1 failed",
    });
  };
  return { runTests, requests };
}

describe("refactor mode: the rewrite", () => {
  it("comes back as a diff, marked as logic-changing", async () => {
    const { run } = setup(refactorReply(rewrite));
    const result = await run();
    expect(result.status).toBe("changed");
    expect(result.mode).toBe("refactor");
    expect(result.changesLogic).toBe(true);
    expect(result.verification).toBe("not-run");
    expect(result.outputCode).toBe(rewrite);
    expect(result.diff).toContain("+    return sum(items)");
    expect(result.refactorChanges).toEqual(["Replaced the loop with sum()"]);
    expect(result.testResult).toBeUndefined();
  });

  it("is requested with the refactor prompt and schema, on plain unnumbered code", async () => {
    const { provider, run } = setup(refactorReply(rewrite));
    await run();
    const request = provider.requests[0];
    expect(request?.jsonSchema).toBe(refactorPlanJsonSchema);
    expect(request?.system).toMatch(/You refactor source code/);
    expect(request?.user).toContain(
      "File: cart.py (python)\n\ndef total(items):",
    );
  });

  it("keeps the file's CRLF line endings", async () => {
    const { run } = setup(refactorReply(rewrite));
    const result = await run({
      path: "cart.py",
      code: original.replace(/\n/g, "\r\n"),
    });
    expect(result.outputCode).toBe(rewrite.replace(/\n/g, "\r\n"));
  });

  it("is rejected when it doesn't parse", async () => {
    const { run } = setup(refactorReply("def total(items:\n    return 1\n"));
    const result = await run();
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("the rewritten code does not parse");
    expect(result.outputCode).toBe(original);
    expect(result.changesLogic).toBe(false);
  });

  it("is rejected when the formatter rejects it", async () => {
    let formatCalls = 0;
    const strictFormatter: LanguageAdapter = {
      ...python,
      format(code) {
        formatCalls += 1;
        if (formatCalls > 1) throw new Error("cannot format line 2");
        return Promise.resolve({ code, formatted: true });
      },
    };
    const { run } = setup(refactorReply(rewrite), { adapter: strictFormatter });
    const result = await run();
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe(
      "the formatter rejected the rewritten code (cannot format line 2)",
    );
  });

  it("gets one retry after an invalid reply, then the file is skipped", async () => {
    const { provider, run } = setup(["not json", '{"changes": []}']);
    const result = await run();
    expect(provider.requests).toHaveLength(2);
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toMatch(/invalid reply 2 times/);
  });
});

describe("refactor mode: files that are never sent", () => {
  it("skips languages without full support, since the rewrite can't be parse-checked", async () => {
    const { provider, run } = setup(refactorReply(rewrite));
    const result = await run({ path: "cart.rb", code: "puts 1\n" });
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toMatch(/needs full support for ruby/);
    expect(provider.requests).toHaveLength(0);
  });

  it("skips files with likely secrets, which couldn't be restored in the rewrite", async () => {
    const { provider, run } = setup(refactorReply(rewrite));
    const result = await run({
      path: "cart.py",
      code: 'password = "hunter2hunter2"\n',
    });
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toMatch(/likely secrets/);
    expect(provider.requests).toHaveLength(0);
  });
});

describe("refactor mode: test command", () => {
  it.each([true, false])(
    "reports passed=%s for the rewritten code",
    async (passed) => {
      const { runTests, requests } = fakeTestRunner({ passed });
      const { run } = setup(refactorReply(rewrite), { runTests });
      const result = await run(undefined, configWithTests);
      expect(result.testResult?.passed).toBe(passed);
      expect(requests).toEqual([
        { path: "cart.py", code: rewrite, command: "npm test" },
      ]);
    },
  );

  it("warns when a test command is set but the front-end can't run tests", async () => {
    const { run } = setup(refactorReply(rewrite));
    const result = await run(undefined, configWithTests);
    expect(result.testResult).toBeUndefined();
    expect(result.warnings.join("\n")).toMatch(/can't run tests/);
  });

  it("turns a runner failure into a warning", async () => {
    const { runTests } = fakeTestRunner(new Error("ENOENT: cart.py"));
    const { run } = setup(refactorReply(rewrite), { runTests });
    const result = await run(undefined, configWithTests);
    expect(result.status).toBe("changed");
    expect(result.warnings).toContain(
      "Tests could not be run: ENOENT: cart.py",
    );
  });

  it("doesn't run tests when the rewrite changes nothing", async () => {
    const { runTests, requests } = fakeTestRunner({ passed: true });
    const { run } = setup(refactorReply(original), { runTests });
    const result = await run(undefined, configWithTests);
    expect(result.status).toBe("unchanged");
    expect(requests).toHaveLength(0);
  });

  it("isn't used outside refactor mode", async () => {
    const { runTests, requests } = fakeTestRunner({ passed: true });
    const { run } = setup('{"insertions": []}', { runTests });
    const result = await run(undefined, resolveConfig({ testCommand: "x" }));
    expect(result.changesLogic).toBe(false);
    expect(requests).toHaveLength(0);
  });
});
