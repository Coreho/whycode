// Tests for unified diff output shown in previews.
import { describe, expect, it } from "vitest";
import { createUnifiedDiff } from "./diff.js";

describe("createUnifiedDiff", () => {
  it("returns an empty string when nothing changed", () => {
    expect(createUnifiedDiff("src/app.py", "a\nb\n", "a\nb\n")).toBe("");
  });

  it("produces a git-style diff with a/ and b/ file headers", () => {
    const diff = createUnifiedDiff("src/app.py", "a\nb\n", "a\n# note\nb\n");
    expect(diff).toContain("--- a/src/app.py");
    expect(diff).toContain("+++ b/src/app.py");
    expect(diff).toContain("+# note");
    expect(diff).not.toContain("Index:");
  });

  it("shows Windows paths with forward slashes", () => {
    const diff = createUnifiedDiff("src\\app.py", "a\n", "b\n");
    expect(diff).toContain("--- a/src/app.py");
  });
});
