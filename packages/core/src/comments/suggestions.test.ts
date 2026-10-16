// Tests for applying accepted comment suggestions: only comment text may
// change, with real tree-sitter tokens for Python, TypeScript, Java and C#,
// and whole comment lines only for comments-only languages. Several cases
// reproduce ways a suggestion used to change code.
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

const CR = String.fromCharCode(13);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const BOM = String.fromCharCode(0xfeff);

describe("applyCommentSuggestions", () => {
  describe("whole comment lines", () => {
    it("replaces a Python comment line", async () => {
      const code = "x = 1\n# add two\ny = x + 1\n";
      const result = await apply("a.py", code, [
        suggest(2, "# add two", "# Add one."),
      ]);
      expect(result.code).toBe("x = 1\n# Add one.\ny = x + 1\n");
      expect(result.applied).toHaveLength(1);
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

    it("always writes the comment marker, even when the AI leaves it out", async () => {
      const code = "# remove stale cache files\nrm -rf cache\n";
      const result = await apply("clean.sh", code, [
        suggest(
          1,
          "remove stale cache files",
          "Remove cache files older than a day.",
        ),
      ]);
      expect(result.code).toBe(
        "# Remove cache files older than a day.\nrm -rf cache\n",
      );
    });

    it("turns any line break in the suggestion into more comment lines", async () => {
      const code = "class A {\n  // old\n  int x;\n}\n";
      const result = await apply("A.java", code, [
        suggest(2, "// old", `// new${CR}class B {}`),
      ]);
      expect(result.code).toBe(
        "class A {\n  // new\n  // class B {}\n  int x;\n}\n",
      );

      const csharp = await apply("A.cs", code, [
        suggest(2, "// old", `// new${LINE_SEPARATOR}class B {}`),
      ]);
      expect(csharp.code).toBe(
        "class A {\n  // new\n  // class B {}\n  int x;\n}\n",
      );
    });

    it("drops a trailing backslash, which would continue a C comment onto the code below", async () => {
      const code = "// old\nint x = 1;\n";
      const result = await apply("a.c", code, [
        suggest(1, "// old", "// new \\"),
      ]);
      expect(result.code).toBe("// new\nint x = 1;\n");
    });

    it("refuses an original that includes code, which could move it", async () => {
      const python =
        'if ready:\n        # note: always runs\n    print("done")\n';
      const result = await apply("a.py", python, [
        suggest(2, '# note: always runs\n    print("done")', "# Better."),
      ]);
      expect(result.code).toBe(python);
      expect(result.notApplied).toHaveLength(1);

      const js = "function f(x) {\n  return // early\n    x;\n}\n";
      const jsResult = await apply("a.js", js, [
        suggest(2, "// early\n    x;", "// early"),
      ]);
      expect(jsResult.code).toBe(js);
    });
  });

  describe("comments after code", () => {
    it("works whether or not the AI included the comment marker", async () => {
      const result = await apply("a.py", "x = 1  # old\n", [
        suggest(1, "old", "# new"),
      ]);
      expect(result.code).toBe("x = 1  # new\n");
    });

    it("keeps the comment on one line", async () => {
      const code = "x = 1  # old\n";
      const result = await apply("a.py", code, [
        suggest(1, "# old", "# new\nimport os"),
      ]);
      expect(result.code).toBe(code);
      expect(result.notApplied[0]?.reason).toMatch(/must stay on one line/);
    });

    it("refuses text that is really inside a string", async () => {
      const code = 's = "x # old"\n';
      const result = await apply("a.py", code, [
        suggest(1, '# old"', '# new"'),
      ]);
      expect(result.code).toBe(code);
    });
  });

  describe("block comments", () => {
    it("rewrites a JSDoc block on its own lines into any shape", async () => {
      const code = "class A {\n  /** Old. */\n  run() {}\n}\n";
      const result = await apply("a.ts", code, [
        suggest(2, "/** Old. */", "/**\n * Runs it.\n */"),
      ]);
      expect(result.code).toBe(
        "class A {\n  /**\n   * Runs it.\n   */\n  run() {}\n}\n",
      );
    });

    it("keeps the line-break structure of a block comment next to code", async () => {
      const code = "function f(x) {\n  return /* old */ x;\n}\n";
      const result = await apply("a.js", code, [
        suggest(2, "/* old */", "/*\n * new\n */"),
      ]);
      expect(result.code).toBe(code);
      expect(result.notApplied[0]?.reason).toMatch(/line breaks/);

      const sameLine = await apply("a.js", code, [
        suggest(2, "/* old */", "/* new */"),
      ]);
      expect(sameLine.code).toBe("function f(x) {\n  return /* new */ x;\n}\n");
    });

    it("strips bidirectional controls from a block comment rewrite", async () => {
      const rightToLeftOverride = String.fromCharCode(0x202e);
      const code = "/* old */\nlet x = 1;\n";
      const result = await apply("a.js", code, [
        suggest(1, "/* old */", `/* new${rightToLeftOverride} */`),
      ]);
      expect(result.code).toBe("/* new */\nlet x = 1;\n");
    });

    it("refuses a replacement that closes the comment early", async () => {
      const code = "/* old */\nlet x = 1;\n";
      const result = await apply("a.js", code, [
        suggest(1, "/* old */", "/* new */ let y = 2; /* end */"),
      ]);
      expect(result.code).toBe(code);
    });
  });

  it("refuses a suggestion that would change code, such as a docstring", async () => {
    const code = 'def f():\n    """Old."""\n    return 1\n';
    const result = await apply("a.py", code, [
      suggest(2, '"""Old."""', '"""New."""'),
    ]);
    expect(result.code).toBe(code);
    expect(result.notApplied).toHaveLength(1);
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

  it("keeps each line's own line ending, and the text untouched if nothing applies", async () => {
    const mixed = "x = 1\r\n# old\ny = 2\r\n";
    const applied = await apply("a.py", mixed, [suggest(2, "# old", "# new")]);
    expect(applied.code).toBe("x = 1\r\n# new\ny = 2\r\n");

    const nothing = await apply("a.py", mixed, [suggest(1, "# gone", "# new")]);
    expect(nothing.code).toBe(mixed);
  });

  it("keeps a byte-order mark at the start of the file", async () => {
    const code = `${BOM}# old\nx = 1\n`;
    const result = await apply("a.py", code, [suggest(1, "# old", "# new")]);
    expect(result.code).toBe(`${BOM}# new\nx = 1\n`);
  });

  it("allows only whole comment lines in comments-only languages", async () => {
    const code = '# old\nputs "x" # old\n';
    const result = await apply("a.rb", code, [
      suggest(1, "# old", "# new"),
      suggest(2, "# old", "# new"),
    ]);
    expect(result.code).toBe('# new\nputs "x" # old\n');
    expect(result.notApplied[0]?.reason).toMatch(/only whole comment lines/);
  });

  it("refuses suggestions for unsupported file types", async () => {
    const result = await apply("notes.txt", "old\n", [
      suggest(1, "old", "new"),
    ]);
    expect(result.notApplied[0]?.reason).toBe("unsupported file type");
  });
});
