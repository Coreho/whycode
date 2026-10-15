// Tests for applying accepted comment suggestions: only comment text may
// change, with real tree-sitter tokens for Python and TypeScript, and a
// whole-line-comment rule for comments-only languages.
import { describe, expect, it } from "vitest";
import type { ExistingCommentSuggestion } from "../ai/comment-plan.js";
import { defaultAdapters } from "../languages/index.js";
import { applyCommentSuggestions } from "./suggestions.js";

const suggest = (
  line: number,
  original: string,
  suggested: string,
): ExistingCommentSuggestion => ({ line, original, suggested, reason: "why" });

const apply = (
  path: string,
  code: string,
  suggestions: ExistingCommentSuggestion[],
) => applyCommentSuggestions(path, code, suggestions, defaultAdapters);

describe("applyCommentSuggestions", () => {
  it("replaces a Python comment on the given line", async () => {
    const code = "x = 1\n# add two\ny = x + 1\n";
    const result = await apply("a.py", code, [
      suggest(2, "# add two", "# Add one."),
    ]);
    expect(result.code).toBe("x = 1\n# Add one.\ny = x + 1\n");
    expect(result.applied).toHaveLength(1);
    expect(result.notApplied).toEqual([]);
  });

  it("works whether or not the AI included the comment marker", async () => {
    const code = "x = 1  # old\n";
    const result = await apply("a.py", code, [suggest(1, "old", "# new")]);
    expect(result.code).toBe("x = 1  # new\n");
  });

  it("applies several suggestions bottom-up, even ones that add lines", async () => {
    const code = "def f():\n    # one\n    a = 1\n    # two\n    return a\n";
    const result = await apply("a.py", code, [
      suggest(2, "# one", "# First line.\n# Second line."),
      suggest(4, "# two", "# Second."),
    ]);
    expect(result.code).toBe(
      "def f():\n    # First line.\n    # Second line.\n    a = 1\n    # Second.\n    return a\n",
    );
  });

  it("indents the continuation lines of a JSDoc block", async () => {
    const code = "class A {\n  /** Old. */\n  run() {}\n}\n";
    const result = await apply("a.ts", code, [
      suggest(2, "/** Old. */", "/**\n * Runs it.\n */"),
    ]);
    expect(result.code).toBe(
      "class A {\n  /**\n   * Runs it.\n   */\n  run() {}\n}\n",
    );
  });

  it("refuses a suggestion that would change code, such as a docstring", async () => {
    const code = 'def f():\n    """Old."""\n    return 1\n';
    const result = await apply("a.py", code, [
      suggest(2, '"""Old."""', '"""New."""'),
    ]);
    expect(result.code).toBe(code);
    expect(result.notApplied[0]?.reason).toMatch(/would change code/);
  });

  it("refuses a suggestion that smuggles code out of the comment", async () => {
    const code = "x = 1\n# note\n";
    const result = await apply("a.py", code, [
      suggest(2, "# note", "# fine\nimport os"),
    ]);
    expect(result.code).toBe(code);
    expect(result.notApplied[0]?.reason).toMatch(/would change code/);
  });

  it("refuses when the comment isn't on the given line any more", async () => {
    const code = "x = 1\n# note\n";
    const result = await apply("a.py", code, [
      suggest(1, "# note", "# better"),
      suggest(9, "# note", "# better"),
    ]);
    expect(result.code).toBe(code);
    expect(result.notApplied.map((entry) => entry.reason)).toEqual([
      "line 9 is past the end of the file",
      "line 1 no longer holds the comment it would replace",
    ]);
  });

  it("keeps CRLF line endings", async () => {
    const code = "x = 1\r\n# old\r\ny = 2\r\n";
    const result = await apply("a.py", code, [suggest(2, "# old", "# new")]);
    expect(result.code).toBe("x = 1\r\n# new\r\ny = 2\r\n");
  });

  it("allows only whole-line, single-line comments in comments-only languages", async () => {
    const code = '# old\nputs "# old"\n';
    const result = await apply("a.rb", code, [
      suggest(1, "# old", "# new"),
      suggest(2, "old", "new"),
    ]);
    expect(result.code).toBe('# new\nputs "# old"\n');
    expect(result.notApplied[0]?.reason).toMatch(/only a single-line comment/);

    const multiLine = await apply("a.rb", "# old\n", [
      suggest(1, "# old", "# one\n# two"),
    ]);
    expect(multiLine.notApplied).toHaveLength(1);
  });

  it("refuses suggestions for unsupported file types", async () => {
    const result = await apply("notes.txt", "old\n", [
      suggest(1, "old", "new"),
    ]);
    expect(result.notApplied[0]?.reason).toBe("unsupported file type");
  });
});
