// Runs Go fixtures through the real pipeline with scripted AI replies.
// Safety probes disable gofmt so results do not depend on its installation.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AIRequest } from "../ai/provider.js";
import { resolveConfig } from "../config.js";
import { processFile } from "../pipeline.js";
import { commentPlanReply, FakeAIProvider } from "../testing/fake-provider.js";
import {
  commentAboveEveryMatch,
  commentAboveFirstMatch,
} from "../testing/scripted-replies.js";
import type { LanguageAdapter } from "./adapter.js";
import { createGoAdapter, goAdapter } from "./go.js";
import { defaultAdapters } from "./index.js";

const FIXTURES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "go");
const PROBE = "Probe comment.";
const unformattedGo = createGoAdapter({
  runProcess: () => Promise.resolve({ kind: "not-found" }),
});

async function runCode(
  code: string,
  reply: (request: AIRequest) => string,
  adapters: readonly LanguageAdapter[] = [unformattedGo],
) {
  return processFile({ path: "go/verification.go", code }, resolveConfig(), {
    provider: new FakeAIProvider(reply),
    adapters,
  });
}

async function runFixture(pattern: RegExp, text = PROBE) {
  const code = await readFile(join(FIXTURES_DIR, "verification.go"), "utf8");
  return {
    code,
    result: await runCode(code, commentAboveFirstMatch(pattern, text)),
  };
}

async function expectCleanParse(code: string) {
  const tokens = await goAdapter.tokens(code);
  expect(tokens).not.toContain("<<syntax-error>>");
  expect(tokens.some((token) => token.startsWith("<<missing "))).toBe(false);
}

describe("Go pipeline fixtures", () => {
  it("keeps comments above every func, method and type in messy.go", async () => {
    const code = await readFile(join(FIXTURES_DIR, "messy.go"), "utf8");
    const result = await runCode(
      code,
      commentAboveEveryMatch(/^(func\b|type\b)/, PROBE),
      defaultAdapters,
    );
    expect(result.languageId).toBe("go");
    expect(result.mode).toBe("full");
    expect(result.status).toBe("changed");
    expect(result.verification).toBe("passed");
    const definitions = code
      .split("\n")
      .filter((line) => /^(func\b|type\b)/.test(line));
    expect(definitions.length).toBe(5);
    expect(result.outputCode.split(PROBE)).toHaveLength(definitions.length + 1);
    await expectCleanParse(result.outputCode);
  });

  it("warns and still verifies comments when gofmt is missing", async () => {
    const { result } = await runFixture(/^func summarize/);
    expect(result.formatted).toBe(false);
    expect(result.verification).toBe("passed");
    expect(result.outputCode).toContain(`// ${PROBE}`);
    expect(result.warnings).toContain(
      "No formatter available for go; formatting was skipped.",
    );
  });

  it("discards a comment inside a raw string literal", async () => {
    const { code, result } = await runFixture(/^Your order has shipped/);
    expect(result.verification).toBe("failed");
    expect(result.outputCode).toBe(code);
    expect(result.warnings.join("\n")).toMatch(
      /tokens changed \(token \d+: expected/,
    );
  });

  it("discards a changed operator and names the differing token", async () => {
    let formatCalls = 0;
    const adapter: LanguageAdapter = {
      ...unformattedGo,
      async format(code) {
        formatCalls += 1;
        if (formatCalls === 1) return unformattedGo.format(code);
        const mutated = code.replace("len(entries) * 2", "len(entries) + 2");
        if (mutated === code) throw new Error("Logic change did not apply.");
        return { code: mutated, formatted: false };
      },
    };
    const code = await readFile(join(FIXTURES_DIR, "verification.go"), "utf8");
    const result = await runCode(
      code,
      commentAboveFirstMatch(/^func summarize/, PROBE),
      [adapter],
    );
    expect(result.verification).toBe("failed");
    expect(result.outputCode).toBe(code);
    expect(result.outputCode).not.toContain(PROBE);
    expect(result.warnings.join("\n")).toMatch(/expected "\*", found "\+"/);
  });

  it.each([
    ["build constraint", /^\/\/go:build cgo$/, "//go:build cgo"],
    [
      "generate and embed directives",
      /^var source string$/,
      "//go:embed verification.go",
    ],
    ["function directive", /^func summarize/, "//go:noinline"],
  ])(
    "keeps an explanation above a declaration with a %s",
    async (_name, target, directive) => {
      const { code, result } = await runFixture(target);
      expect(result.verification).toBe("passed");
      expect(result.outputCode).toContain(`// ${PROBE}`);
      const directives = (text: string) =>
        text.split("\n").filter((line) => line.startsWith("//go:"));
      expect(directives(result.outputCode)).toEqual(directives(code));
      expect(result.outputCode).toContain(directive);
      await expectCleanParse(result.outputCode);
    },
  );

  it.each([
    ["struct field tag", /^\s*Name string/],
    ["goto label", /^retry:/],
    ["labeled break", /^\s*break collect/],
    ["composite literal element", /^\s*"summary",/],
    ["method chain", /^\s*Replace\(strings.Join/],
  ])("keeps a valid explanation above a %s", async (_name, target) => {
    const { result } = await runFixture(target);
    expect(result.verification).toBe("passed");
    expect(result.outputCode).toContain(`// ${PROBE}`);
    await expectCleanParse(result.outputCode);
  });

  it.each(["/// x", "//go:build evil", "Explains this. */ panic(123)"])(
    "renders %s as a spaced line comment",
    async (text) => {
      const { code, result } = await runFixture(/^func summarize/, text);
      expect(result.verification).toBe("passed");
      const addedLines = result.outputCode
        .split("\n")
        .filter((line) => !code.split("\n").includes(line));
      expect(addedLines).toHaveLength(1);
      expect(addedLines[0]).toMatch(/^\s*\/\/ /);
      expect(addedLines[0]).not.toMatch(/^\s*\/\/go:/);
      await expectCleanParse(result.outputCode);
    },
  );
});

describe("Go pipeline cgo protection", () => {
  it.each([
    ["immediately above import C", /^import "C"/],
    ["joining the preamble from above", /^\/\*$/],
    ["inside the C block comment", /^typedef int number;/],
  ])("discards a comment %s", async (_name, target) => {
    const { code, result } = await runFixture(target);
    expect(result.verification).toBe("failed");
    expect(result.outputCode).toBe(code);
    expect(result.outputCode).not.toContain(PROBE);
    expect(result.warnings.join("\n")).toMatch(/tokens changed/);
  });

  it("keeps an explanation above an ordinary import", async () => {
    const { result } = await runFixture(/^import \(/);
    expect(result.verification).toBe("passed");
    expect(result.outputCode).toContain(`// ${PROBE}\nimport (`);
  });

  it("keeps an explanation separated from the preamble by a blank line", async () => {
    const code =
      'package p\n\n// Existing explanation.\n\n// typedef int number;\nimport "C"\n';
    const result = await runCode(
      code,
      commentAboveFirstMatch(/^\/\/ Existing/, PROBE),
    );
    expect(result.verification).toBe("passed");
    expect(result.outputCode).toContain(`// ${PROBE}`);
  });

  it("rejects creating a new preamble on a bare C import", async () => {
    const code = 'package p\n\nimport "C"\n';
    const result = await runCode(
      code,
      commentAboveFirstMatch(/^import/, PROBE),
    );
    expect(result.verification).toBe("failed");
    expect(result.outputCode).toBe(code);
  });

  it("leaves the risky fixture unchanged with an empty comment plan", async () => {
    const code = await readFile(join(FIXTURES_DIR, "verification.go"), "utf8");
    const result = await runCode(code, () => commentPlanReply({}));
    expect(result.verification).toBe("passed");
    expect(result.outputCode).toBe(code);
    await expectCleanParse(result.outputCode);
  });
});
