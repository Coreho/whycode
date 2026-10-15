// Tests for parsing the AI's comment plan, including malformed replies.
import { describe, expect, it } from "vitest";
import { parseCommentPlan } from "./comment-plan.js";

const validPlan = {
  insertions: [
    { line: 3, position: "above", text: "Retries because the API is flaky." },
  ],
  existingCommentSuggestions: [
    {
      line: 1,
      original: "# do it",
      suggested: "# Fetch prices",
      reason: "More specific.",
    },
  ],
};

describe("parseCommentPlan", () => {
  it("parses a valid plan", () => {
    expect(parseCommentPlan(JSON.stringify(validPlan))).toEqual({
      ok: true,
      plan: validPlan,
    });
  });

  it("treats missing existingCommentSuggestions as an empty list", () => {
    const result = parseCommentPlan(
      JSON.stringify({ insertions: validPlan.insertions }),
    );
    expect(result).toEqual({
      ok: true,
      plan: {
        insertions: validPlan.insertions,
        existingCommentSuggestions: [],
      },
    });
  });

  it("accepts JSON wrapped in a Markdown code fence", () => {
    const fenced = "```json\n" + JSON.stringify(validPlan) + "\n```";
    expect(parseCommentPlan(fenced)).toEqual({ ok: true, plan: validPlan });
  });

  it("rejects text that is not JSON", () => {
    expect(parseCommentPlan("Sure! Here are your comments.")).toEqual({
      ok: false,
      error: "AI response is not valid JSON.",
    });
  });

  it("rejects a plan without insertions", () => {
    const result = parseCommentPlan(
      JSON.stringify({ existingCommentSuggestions: [] }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects wrong types and says where the problem is", () => {
    const wrong = { insertions: [{ line: "3", position: "above", text: "x" }] };
    const result = parseCommentPlan(JSON.stringify(wrong));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/insertions/);
  });

  it("rejects line numbers below 1 and blank comment text", () => {
    const zeroLine = {
      insertions: [{ line: 0, position: "above", text: "x" }],
    };
    const blankText = {
      insertions: [{ line: 1, position: "above", text: "   " }],
    };
    expect(parseCommentPlan(JSON.stringify(zeroLine)).ok).toBe(false);
    expect(parseCommentPlan(JSON.stringify(blankText)).ok).toBe(false);
  });
});
