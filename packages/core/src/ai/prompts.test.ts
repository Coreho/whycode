// Tests for the comment-pass prompt: numbered code and level guidance.
import { describe, expect, it } from "vitest";
import { buildCommentPrompt, numberLines } from "./prompts.js";

describe("numberLines", () => {
  it("prefixes each line with its 1-based number", () => {
    expect(numberLines("a\nb")).toBe("1| a\n2| b");
  });
});

describe("buildCommentPrompt", () => {
  it("includes the language, the comment level, and the numbered code", () => {
    const request = buildCommentPrompt({
      code: "x = 1",
      languageId: "python",
      commentLevel: "heavy",
    });
    expect(request.user).toContain("Language: python");
    expect(request.user).toContain("Comment level: heavy");
    expect(request.user).toContain("1| x = 1");
    expect(request.system).toContain("Reply with JSON only");
  });
});
