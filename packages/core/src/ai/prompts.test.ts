// Tests for the comment-pass prompt: level guidance, cache-stable system
// prompts, numbered code, and the attached JSON schema.
import { describe, expect, it } from "vitest";
import { commentPlanJsonSchema } from "./comment-plan.js";
import { buildCommentPrompt, numberLines, systemPrompt } from "./prompts.js";

const input = {
  path: "src\\billing\\rates.py",
  code: "x = 1\ny = 2",
  languageId: "python",
  commentLevel: "light" as const,
};

describe("numberLines", () => {
  it("prefixes each line with its 1-based number", () => {
    expect(numberLines("a\nb")).toBe("1| a\n2| b");
  });
});

describe("buildCommentPrompt", () => {
  it("sends the file path, language, and numbered code in the user message", () => {
    const request = buildCommentPrompt(input);
    expect(request.user).toBe(
      "File: src/billing/rates.py (python)\n\n1| x = 1\n2| y = 2",
    );
  });

  it("attaches the comment-plan JSON schema", () => {
    expect(buildCommentPrompt(input).jsonSchema).toBe(commentPlanJsonSchema);
  });

  it("keeps the system prompt identical across files, so it can be cached", () => {
    const first = buildCommentPrompt(input);
    const second = buildCommentPrompt({
      ...input,
      path: "other.ts",
      code: "z",
      languageId: "typescript",
    });
    expect(second.system).toBe(first.system);
  });
});

describe("systemPrompt", () => {
  it("gives different guidance for each comment level", () => {
    expect(systemPrompt("light")).toContain("Comment level: light.");
    expect(systemPrompt("medium")).toContain(
      "each logical block inside a function",
    );
    expect(systemPrompt("heavy")).toContain("learning this language");
    expect(
      new Set([
        systemPrompt("light"),
        systemPrompt("medium"),
        systemPrompt("heavy"),
      ]).size,
    ).toBe(3);
  });

  it("steers comments toward why rather than restating the code", () => {
    const prompt = systemPrompt("light");
    expect(prompt).toContain("It explains why");
    expect(prompt).toContain("doesn't restate names or types");
  });

  it("warns against the placements that verification rejects", () => {
    const prompt = systemPrompt("medium");
    expect(prompt).toContain(
      "multi-line string, template literal, docstring, or JSX/HTML text",
    );
    expect(prompt).toContain("backslash line continuation");
  });

  it("describes the JSON reply shape for providers that can't enforce a schema", () => {
    expect(systemPrompt("heavy")).toContain("Reply with JSON only");
  });
});

describe("commentPlanJsonSchema", () => {
  it("is a plain object schema without the $schema dialect marker", () => {
    expect(commentPlanJsonSchema.type).toBe("object");
    expect(commentPlanJsonSchema).not.toHaveProperty("$schema");
  });
});
