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

  describe("comment lines quoted as one joined sentence", () => {
    // The shape of a suggestion seen in a real run on nudl.
    const code = [
      "try:",
      "    register()",
      "except OSError as exc:",
      "    # Only a genuine OS failure means someone else owns this. A bad",
      "    # handle is a bug in the app and must not be reported this way.",
      "    raise Busy() from exc",
      "",
    ].join("\n");

    it("replaces the lines and wraps the rewrite to their width", async () => {
      const result = await apply("a.py", code, [
        suggest(
          4,
          "Only a genuine OS failure means someone else owns this. A bad handle is a bug in the app and must not be reported this way.",
          "Every OSError is reported as Busy, including a bad handle, which is really a bug in the app.",
        ),
      ]);
      expect(result.notApplied).toEqual([]);
      expect(result.code).toBe(
        [
          "try:",
          "    register()",
          "except OSError as exc:",
          "    # Every OSError is reported as Busy, including a bad handle,",
          "    # which is really a bug in the app.",
          "    raise Busy() from exc",
          "",
        ].join("\n"),
      );
    });

    it("refuses a quote that ends partway through a comment line", async () => {
      const result = await apply("a.py", code, [
        suggest(4, "Only a genuine OS failure means someone else", "x"),
      ]);
      expect(result.code).toBe(code);
    });
  });

  describe("text inside a block comment on its own lines", () => {
    // The shape of a stale doc comment found in a real run on GrammieGuide.
    const doc = [
      "/**",
      " * Theme tokens for the launcher.",
      " * Six palettes: four soft themes share one tile color per",
      " * theme, while the two bold themes give each tile its own",
      " * hue - colors cycle by saved slot.",
      " */",
      "export const THEMES = 7;",
      "",
    ].join("\n");
    const prose = (code: string) =>
      code
        .split("\n")
        .slice(1, -3)
        .map((line) => line.replace(/^ \* ?/, ""))
        .join(" ");
    const fixed =
      "Seven palettes: four soft themes share one tile color per theme, while the two bold themes and the card theme give each tile its own hue";

    it.each([
      [
        "quoted across lines, ending mid-line",
        "Six palettes: four soft themes share one tile color per\ntheme, while the two bold themes give each tile its own\nhue",
      ],
      [
        "quoted on one line",
        "Six palettes: four soft themes share one tile color per theme, while the two bold themes give each tile its own hue",
      ],
      [
        "quoted with the * prefixes",
        " * Six palettes: four soft themes share one tile color per\n * theme, while the two bold themes give each tile its own\n * hue",
      ],
    ])("replaces text %s, keeping the block", async (_shape, original) => {
      const result = await apply("theme.ts", doc, [
        suggest(3, original, fixed),
      ]);
      expect(result.notApplied).toEqual([]);
      const lines = result.code.split("\n");
      expect(lines.slice(0, 2)).toEqual([
        "/**",
        " * Theme tokens for the launcher.",
      ]);
      expect(lines.slice(-3)).toEqual([" */", "export const THEMES = 7;", ""]);
      expect(prose(result.code)).toBe(
        `Theme tokens for the launcher. ${fixed} - colors cycle by saved slot.`,
      );
      // Re-wrapped to the block's own width, with its * prefix.
      for (const line of lines.slice(2, -3)) {
        expect(line.startsWith(" * ")).toBe(true);
        expect(line.length).toBeLessThanOrEqual(58);
      }
    });

    it("re-wraps the rest of the paragraph when the quote ends mid-line", async () => {
      const code = [
        "/**",
        " * Old words here and more text that",
        " * continues on this line.",
        " *",
        " * @param x the input",
        " */",
        "f();",
        "",
      ].join("\n");
      const result = await apply("a.ts", code, [
        suggest(2, "Old words", "Newer, longer words"),
      ]);
      expect(result.code).toBe(
        [
          "/**",
          " * Newer, longer words here and more",
          " * text that continues on this line.",
          " *",
          " * @param x the input",
          " */",
          "f();",
          "",
        ].join("\n"),
      );
    });

    it("keeps the markers of a one-line block", async () => {
      const code = "  /** Uses the old A-/A+ control. */\n  run();\n";
      const result = await apply("a.ts", code, [
        suggest(1, "Uses the old A-/A+ control.", "Uses the admin slider."),
      ]);
      expect(result.code).toBe("  /** Uses the admin slider. */\n  run();\n");
    });

    it("refuses text that isn't in the block, or appears in it twice", async () => {
      const twice = "/**\n * Old note.\n * Old note.\n */\nrun();\n";
      const result = await apply("a.ts", doc + twice, [
        suggest(3, "Nine palettes", "Seven palettes"),
        suggest(10, "Old note.", "New note."),
      ]);
      expect(result.code).toBe(doc + twice);
      expect(result.notApplied.map((entry) => entry.reason)).toEqual([
        "the quoted text appears more than once in the block comment at line 10",
        "the quoted text isn't in the block comment at line 3",
      ]);
    });

    it("refuses a rewrite that would close the comment early", async () => {
      const result = await apply("theme.ts", doc, [
        suggest(
          3,
          "Six palettes:",
          "Seven palettes: */ export const X = 1; /*",
        ),
      ]);
      expect(result.code).toBe(doc);
      expect(result.notApplied[0]?.reason).toBe(
        "the rewrite would end the comment early or start another one",
      );
    });

    it("leaves text that only looks like a block comment, inside a string", async () => {
      const code = "const css = `\n/*\n * Old rule.\n */\n`;\n";
      const result = await apply("a.ts", code, [
        suggest(3, "Old rule.", "New rule."),
      ]);
      expect(result.code).toBe(code);
      expect(result.notApplied[0]?.reason).toMatch(/would change code/);
    });

    it("doesn't treat a block that shares a line with code as standing alone", async () => {
      const code = "run(); /* first\n * second */\n";
      const result = await apply("a.ts", code, [suggest(2, "second", "later")]);
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
      "the quoted comment text isn't at line 1",
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
