// End-to-end runs of the real pipeline and real adapters over the messy
// fixture files, with a fake AI that comments above every definition.
// Also checks that badly placed comments are caught, not applied.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AIRequest } from "../ai/provider.js";
import { resolveConfig } from "../config.js";
import { processFile } from "../pipeline.js";
import { FakeAIProvider } from "../testing/fake-provider.js";
import {
  commentAboveEveryMatch,
  commentAboveFirstMatch,
} from "../testing/scripted-replies.js";
import type { LanguageAdapter } from "./adapter.js";
import { defaultAdapters } from "./index.js";
import { createPythonAdapter } from "./python.js";

const FIXTURES_DIR = join(import.meta.dirname, "..", "..", "fixtures");
const COMMENT_TEXT = "Explains the next definition.";
const DEFINITION =
  /^\s*(def |async def |class |export |function |module\.exports)/;

const commentAboveDefinitions = commentAboveEveryMatch(
  DEFINITION,
  COMMENT_TEXT,
);
const commentAboveLineMatching = (pattern: RegExp) =>
  commentAboveFirstMatch(pattern, "Misplaced comment.");

async function runFixture(
  relativePath: string,
  reply: (request: AIRequest) => string,
  adapters: readonly LanguageAdapter[] = defaultAdapters,
) {
  const code = await readFile(join(FIXTURES_DIR, relativePath), "utf8");
  const provider = new FakeAIProvider(reply);
  return processFile({ path: relativePath, code }, resolveConfig(), {
    provider,
    adapters,
  });
}

// Ruff joins backslash-continued lines, so this Python adapter skips
// formatting to keep the continuation in place for the test.
const unformattedPython = createPythonAdapter({
  runProcess: () => Promise.resolve({ kind: "not-found" }),
});

describe("fixtures: comments above definitions pass verification", () => {
  it.each([
    ["typescript/messy.ts", "typescript"],
    ["typescript/messy.tsx", "tsx"],
    ["javascript/messy.js", "javascript"],
    ["python/messy.py", "python"],
  ])("%s", async (path, languageId) => {
    const result = await runFixture(path, commentAboveDefinitions);

    expect(result.languageId).toBe(languageId);
    expect(result.status).toBe("changed");
    expect(result.verification).toBe("passed");
    expect(result.outputCode).toContain(COMMENT_TEXT);
    // Python formats only where Ruff is installed; Prettier is bundled.
    if (languageId !== "python") expect(result.formatted).toBe(true);
  });
});

describe("fixtures: misplaced comments are caught", () => {
  it("discards a comment that lands inside a TypeScript template literal", async () => {
    const result = await runFixture(
      "typescript/messy.ts",
      commentAboveLineMatching(/^Generated:/),
    );
    expect(result.verification).toBe("failed");
    expect(result.outputCode).not.toContain("Misplaced comment.");
    expect(result.warnings.join("\n")).toMatch(/tokens changed/);
  });

  it("discards a comment that lands inside JSX text", async () => {
    const result = await runFixture(
      "typescript/messy.tsx",
      commentAboveLineMatching(/Member since/),
    );
    expect(result.verification).toBe("failed");
    expect(result.outputCode).not.toContain("Misplaced comment.");
  });

  it("refuses to put a comment after a Python backslash continuation", async () => {
    const result = await runFixture(
      "python/messy.py",
      commentAboveLineMatching(/^\s*subtotal\*self\.tax_rate/),
      [unformattedPython],
    );
    expect(result.outputCode).not.toContain("Misplaced comment.");
    expect(result.warnings.join("\n")).toMatch(/backslash line continuation/);
  });
});
