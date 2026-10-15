// Tests for comment insertion: placement, indentation, ordering, and the
// guarantee that existing lines are never modified.
import { describe, expect, it } from "vitest";
import type { CommentInsertion } from "../ai/comment-plan.js";
import { applyInsertions } from "./insert.js";

const above = (line: number, text: string): CommentInsertion => ({
  line,
  position: "above",
  text,
});

describe("applyInsertions", () => {
  it("inserts a comment above the target line using its indentation", () => {
    const code = "def f():\n    return 1\n";
    const result = applyInsertions(code, [above(2, "Always one.")], "#");
    expect(result.code).toBe("def f():\n    # Always one.\n    return 1\n");
  });

  it("keeps tab indentation", () => {
    const result = applyInsertions(
      "func f() {\n\treturn\n}",
      [above(2, "Done.")],
      "//",
    );
    expect(result.code).toBe("func f() {\n\t// Done.\n\treturn\n}");
  });

  it("places comments at several lines correctly", () => {
    const result = applyInsertions(
      "a\nb\nc\n",
      [above(1, "A"), above(3, "C")],
      "#",
    );
    expect(result.code).toBe("# A\na\nb\n# C\nc\n");
  });

  it("keeps the AI's order for comments on the same line", () => {
    const result = applyInsertions(
      "a",
      [above(1, "first"), above(1, "second")],
      "#",
    );
    expect(result.code).toBe("# first\n# second\na");
  });

  it("turns multi-line text into one comment line per line", () => {
    const result = applyInsertions(
      "x",
      [above(1, "Line one.\n\nLine two.")],
      "#",
    );
    expect(result.code).toBe("# Line one.\n#\n# Line two.\nx");
  });

  it("splits on every line break a JavaScript engine recognizes", () => {
    const lineSeparator = String.fromCharCode(0x2028);
    const result = applyInsertions(
      "x;",
      [above(1, `one${lineSeparator}two`)],
      "//",
    );
    expect(result.code).toBe("// one\n// two\nx;");
  });

  it("splits on U+0085, which ends a line comment in C#", () => {
    const nextLine = String.fromCharCode(0x85);
    const result = applyInsertions(
      "x;",
      [above(1, `one${nextLine}Environment.Exit(1);`)],
      "//",
    );
    expect(result.code).toBe("// one\n// Environment.Exit(1);\nx;");
  });

  it("strips a comment marker the AI included in the text", () => {
    const result = applyInsertions("x", [above(1, "# Already marked")], "#");
    expect(result.code).toBe("# Already marked\nx");
  });

  it("drops comments aimed past the end of the file, with a warning", () => {
    const result = applyInsertions("a\n", [above(5, "Nowhere.")], "#");
    expect(result.code).toBe("a\n");
    expect(result.warnings).toEqual([
      "Dropped a comment for line 5: the file has only 1 lines.",
    ]);
  });

  it("refuses to place a comment right after a backslash line continuation", () => {
    const code = "total = a + \\\n    b\nreturn total\n";
    const result = applyInsertions(
      code,
      [above(2, "Bad."), above(3, "Good.")],
      "#",
    );
    expect(result.code).toBe("total = a + \\\n    b\n# Good.\nreturn total\n");
    expect(result.warnings).toEqual([
      "Dropped a comment for line 2: the line before it ends with a backslash line continuation.",
    ]);
  });

  it("keeps a shebang on the first line", () => {
    const code = "#!/usr/bin/env python3\nprint(1)\n";
    const result = applyInsertions(
      code,
      [above(1, "Bad."), above(2, "Good.")],
      "#",
    );
    expect(result.code).toBe("#!/usr/bin/env python3\n# Good.\nprint(1)\n");
    expect(result.warnings).toEqual([
      "Dropped a comment for line 1: line 1 is a shebang (#!), which must stay the first line.",
    ]);
  });

  it("allows a comment above a Rust #![...] attribute, which isn't a shebang", () => {
    const result = applyInsertions(
      "#![allow(dead_code)]\n",
      [above(1, "Ok.")],
      "//",
    );
    expect(result.code).toBe("// Ok.\n#![allow(dead_code)]\n");
  });

  it("keeps an encoding declaration on line 1 within the first two lines", () => {
    const code = "# -*- coding: latin-1 -*-\nx = 1\n";
    const result = applyInsertions(
      code,
      [above(1, "Bad."), above(2, "Good.")],
      "#",
    );
    expect(result.code).toBe("# -*- coding: latin-1 -*-\n# Good.\nx = 1\n");
    expect(result.warnings).toEqual([
      "Dropped a comment for line 1: line 1 declares the file's encoding, which must stay within the first two lines.",
    ]);
  });

  it("keeps an encoding declaration on line 2, below a shebang, in place", () => {
    const code =
      "#!/usr/bin/env python3\n# vim: set fileencoding=utf-8 :\nx = 1\n";
    const result = applyInsertions(
      code,
      [above(1, "Bad."), above(2, "Bad."), above(3, "Good.")],
      "#",
    );
    expect(result.code).toBe(
      "#!/usr/bin/env python3\n# vim: set fileencoding=utf-8 :\n# Good.\nx = 1\n",
    );
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[1]).toMatch(/line 2 declares the file's encoding/);
  });

  it("never changes existing lines", () => {
    const code = "  first\nsecond  \n\tthird";
    const result = applyInsertions(
      code,
      [above(1, "x"), above(2, "y"), above(3, "z")],
      "#",
    );
    const nonComment = result.code
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"));
    expect(nonComment).toEqual(code.split("\n"));
  });

  it("maps old line numbers to their new positions", () => {
    const result = applyInsertions("a\nb\nc", [above(2, "two\nlines")], "#");
    expect(result.lineMap).toEqual([1, 4, 5]);
  });
});
