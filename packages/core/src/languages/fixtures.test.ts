// End-to-end runs of the real pipeline and real adapters over the messy
// fixture files, with a fake AI that comments above every definition.
// Also checks that badly placed comments are caught, not applied.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommentInsertion } from "../ai/comment-plan.js";
import type { AIRequest } from "../ai/provider.js";
import { resolveConfig } from "../config.js";
import { processFile } from "../pipeline.js";
import { commentPlanReply, FakeAIProvider } from "../testing/fake-provider.js";
import { defaultAdapters } from "./index.js";

const FIXTURES_DIR = join(import.meta.dirname, "..", "..", "fixtures");
const COMMENT_TEXT = "Explains the next definition.";
const DEFINITION =
  /^\s*(def |async def |class |export |function |module\.exports)/;

interface NumberedLine {
  number: number;
  text: string;
}

/** The numbered code lines the pipeline sent to the AI ("12| text"). */
function numberedLines(request: AIRequest): NumberedLine[] {
  return request.user.split("\n").flatMap((line) => {
    const match = /^(\d+)\| (.*)$/.exec(line);
    return match ? [{ number: Number(match[1]), text: match[2] ?? "" }] : [];
  });
}

const above = (line: number, text = COMMENT_TEXT): CommentInsertion => ({
  line,
  position: "above",
  text,
});

/** Fake AI reply: one comment above every line that starts a definition. */
function commentAboveDefinitions(request: AIRequest): string {
  const insertions = numberedLines(request)
    .filter((line) => DEFINITION.test(line.text))
    .map((line) => above(line.number));
  return commentPlanReply({ insertions });
}

/** Fake AI reply: one comment above the first line matching `pattern`. */
function commentAboveLineMatching(pattern: RegExp) {
  return (request: AIRequest): string => {
    const target = numberedLines(request).find((line) =>
      pattern.test(line.text),
    );
    if (target === undefined)
      throw new Error(`No line matches ${String(pattern)}`);
    return commentPlanReply({
      insertions: [above(target.number, "Misplaced comment.")],
    });
  };
}

async function runFixture(
  relativePath: string,
  reply: (request: AIRequest) => string,
) {
  const code = await readFile(join(FIXTURES_DIR, relativePath), "utf8");
  const provider = new FakeAIProvider(reply);
  return processFile({ path: relativePath, code }, resolveConfig(), {
    provider,
    adapters: defaultAdapters,
  });
}

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
      commentAboveLineMatching(
        /^\s*subtotal \* self\.tax_rate|^\s*subtotal\*self\.tax_rate/,
      ),
    );
    expect(result.outputCode).not.toContain("Misplaced comment.");
    expect(result.warnings.join("\n")).toMatch(/backslash line continuation/);
  });
});
