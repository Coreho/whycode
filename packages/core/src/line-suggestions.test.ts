// Exercises exact, independently applicable replacements constrained to preview ranges.
import { describe, expect, it } from "vitest";
import {
  createLineSuggestions,
  unifiedRightRanges,
} from "./line-suggestions.js";

const all = [{ startLine: 1, endLine: 100 }];

describe("createLineSuggestions", () => {
  it("anchors inserted comments to the following original line", () => {
    expect(
      createLineSuggestions("  run()\n", "  # why\n  run()\n", all).suggestions,
    ).toEqual([
      { startLine: 1, endLine: 1, replacement: "  # why\n  run()\n" },
    ]);
  });

  it("keeps separate changes independently applicable and maps output lines", () => {
    const result = createLineSuggestions(
      "a\nb\nc\nd\n",
      "# a\na\nb\nC\nd\n",
      all,
    );
    expect(result.suggestions).toEqual([
      { startLine: 1, endLine: 1, replacement: "# a\na\n" },
      { startLine: 3, endLine: 3, replacement: "C\n" },
    ]);
    expect(result.originalLines.get(3)).toBe(2);
    expect(result.originalLines.has(4)).toBe(false);
  });

  it("requires every replaced line to fit in one allowed range", () => {
    const result = createLineSuggestions("a\nb\nc\n", "A\nB\nc\n", [
      { startLine: 1, endLine: 1 },
      { startLine: 2, endLine: 2 },
    ]);
    expect(result.suggestions).toEqual([]);
    expect(result.withheld).toEqual([
      { startLine: 1, endLine: 2, reason: "outside allowed ranges" },
    ]);
  });

  it("retains CRLF, indentation, trailing spaces, and blank lines exactly", () => {
    expect(
      createLineSuggestions("\tx()\r\n", "\t# why  \r\n\r\n\tx()\r\n", all)
        .suggestions[0]?.replacement,
    ).toBe("\t# why  \r\n\r\n\tx()\r\n");
  });

  it("handles multiline replacements and deletions without adding blank lines", () => {
    expect(
      createLineSuggestions("a\nb\nc\n", "A\nc\n", all).suggestions,
    ).toEqual([{ startLine: 1, endLine: 2, replacement: "A\n" }]);
    expect(createLineSuggestions("a\nb\n", "b\n", all).suggestions).toEqual([
      { startLine: 1, endLine: 1, replacement: "" },
    ]);
  });

  it("anchors EOF insertions to the last original line", () => {
    expect(createLineSuggestions("a\n", "a\n# end\n", all).suggestions).toEqual(
      [{ startLine: 1, endLine: 1, replacement: "a\n# end\n" }],
    );
  });

  it("merges insertions that would otherwise compete for the same anchor", () => {
    expect(
      createLineSuggestions("a\n", "# before\na\n# after\n", all).suggestions,
    ).toEqual([
      { startLine: 1, endLine: 1, replacement: "# before\na\n# after\n" },
    ]);
  });

  it("reconstructs exact text with disjoint suggestions across repeated-line combinations", () => {
    const samples = [
      "a\n",
      "b\n",
      "a\na\n",
      "a\nb\n",
      "a\nb\na\n",
      "b\na\nb\n",
      "# x\na\n# y\n",
      "a\nb\nc\nd\n",
    ];
    for (const before of samples)
      for (const after of samples) {
        const result = createLineSuggestions(before, after, all);
        expect(result.withheld).toEqual([]);
        let previousEnd = 0;
        for (const edit of result.suggestions) {
          expect(edit.startLine).toBeGreaterThan(previousEnd);
          previousEnd = edit.endLine;
        }
        const reconstructed = before.match(/[^\n]*\n/g) ?? [];
        for (const edit of [...result.suggestions].reverse())
          reconstructed.splice(
            edit.startLine - 1,
            edit.endLine - edit.startLine + 1,
            edit.replacement,
          );
        expect(reconstructed.join("")).toBe(after);
      }
  });

  it.each([
    ["", "a\n"],
    ["a", "A"],
    ["a", "a\n"],
    ["a\n", "a"],
  ])(
    "withholds unrepresentable empty-file or EOF edits (%j, %j)",
    (before, after) => {
      const result = createLineSuggestions(before, after, all);
      expect(result.suggestions).toEqual([]);
      expect(result.withheld).toHaveLength(1);
    },
  );

  it("can suggest earlier lines even when the final line has no newline", () => {
    expect(
      createLineSuggestions("a\ntail", "A\ntail", all).suggestions,
    ).toEqual([{ startLine: 1, endLine: 1, replacement: "A\n" }]);
  });

  it("counts disallowed insertion anchors and leaves unchanged files alone", () => {
    expect(
      createLineSuggestions("a\n", "# why\na\n", []).withheld,
    ).toHaveLength(1);
    expect(createLineSuggestions("a\n", "a\n", all).suggestions).toEqual([]);
  });
});

describe("unifiedRightRanges", () => {
  it("reads multiple RIGHT-side hunks, including context and omitted counts", () => {
    expect(
      unifiedRightRanges(
        "@@ -1,2 +1,3 @@\n a\n-b\n+B\n+c\n@@ -8 +9 @@ name\n-x\n+y\n",
      ),
    ).toEqual([
      { startLine: 1, endLine: 3 },
      { startLine: 9, endLine: 9 },
    ]);
  });
  it.each([undefined, "", "@@ -1,2 +1,2 @@\n+x\n", "@@ -1 +0,0 @@\n-x\n"])(
    "refuses absent, truncated, or deletion-only patches",
    (patch) => {
      expect(unifiedRightRanges(patch)).toEqual([]);
    },
  );
});
