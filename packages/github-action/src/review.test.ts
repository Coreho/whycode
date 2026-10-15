// Checks GitHub's RIGHT-side payloads, exact fences, and existing-comment previews.
import { describe, expect, it } from "vitest";
import { processFile, resolveConfig } from "@whycode/core";
import {
  createToyAdapter,
  FakeAIProvider,
  commentPlanReply,
} from "@whycode/core/testing";
import { reviewFile, suggestionBody } from "./review.js";

const adapters = [createToyAdapter()];
const patch = "@@ -1,2 +1,2 @@\n-# old\n+# old\n run()\n";
const process = (code: string, reply: string) =>
  processFile({ path: "a.toy", code }, resolveConfig(), {
    adapters,
    provider: new FakeAIProvider([reply]),
  });

describe("reviewFile", () => {
  it("turns insertions into individually applicable suggestions on original lines", async () => {
    const result = await process(
      "# old\nrun()\n",
      commentPlanReply({
        insertions: [{ line: 2, position: "above", text: "why" }],
      }),
    );
    const review = await reviewFile(result, patch, adapters);
    expect(review.comments).toEqual([
      {
        path: "a.toy",
        line: 2,
        side: "RIGHT",
        body: "```suggestion\n# why\nrun()\n```",
      },
    ]);
  });

  it("maps existing-comment suggestions back past inserted output lines", async () => {
    const result = await process(
      "# old\nrun()\n",
      commentPlanReply({
        insertions: [{ line: 1, position: "above", text: "intro" }],
        existingCommentSuggestions: [
          { line: 1, original: "old", suggested: "clear", reason: "clarity" },
        ],
      }),
    );
    const review = await reviewFile(result, patch, adapters);
    // The insertion uses the same line; the existing-comment alternative is summarized.
    expect(review.comments).toHaveLength(1);
    expect(review.notes.join(" ")).toContain("existing-comment");
  });

  it("offers existing comments separately even when the pipeline is unchanged", async () => {
    const result = await process(
      "# old\nrun()\n",
      commentPlanReply({
        existingCommentSuggestions: [
          { line: 1, original: "old", suggested: "clear", reason: "clarity" },
        ],
      }),
    );
    const review = await reviewFile(result, patch, adapters);
    expect(review.comments[0]?.body).toBe("```suggestion\n# clear\n```");
  });

  it("maps nonoverlapping existing comments past inserted output lines", async () => {
    const result = await process(
      "run()\n# old\n",
      commentPlanReply({
        insertions: [{ line: 1, position: "above", text: "intro" }],
        existingCommentSuggestions: [
          { line: 2, original: "old", suggested: "clear", reason: "clarity" },
        ],
      }),
    );
    const review = await reviewFile(
      result,
      "@@ -1,2 +1,2 @@\n-old\n+run()\n # old\n",
      adapters,
    );
    expect(
      review.comments.map((comment) => [comment.line, comment.body]),
    ).toEqual([
      [1, "```suggestion\n# intro\nrun()\n```"],
      [2, "```suggestion\n# clear\n```"],
    ]);
  });

  it("withholds unsafe existing-comment rewrites and out-of-diff changes", async () => {
    const result = await process(
      "# old\nrun()\n",
      commentPlanReply({
        existingCommentSuggestions: [
          { line: 1, original: "old", suggested: "clear", reason: "clarity" },
        ],
        insertions: [{ line: 2, position: "above", text: "why" }],
      }),
    );
    const review = await reviewFile(result, undefined, adapters);
    expect(review.comments).toEqual([]);
    expect(review.notes.join(" ")).toContain("outside");
    expect(review.notes.join(" ")).toContain("existing-comment");
    result.commentSuggestions = [
      { line: 2, original: "run()", suggested: "erase()", reason: "unsafe" },
    ];
    result.outputCode = result.originalCode;
    expect((await reviewFile(result, patch, adapters)).comments).toEqual([]);
  });

  it("uses multiline coordinates only for multiline replacements", async () => {
    const result = await process("# old\nrun()\n", commentPlanReply({}));
    result.outputCode = "# replacement\n";
    expect(
      (await reviewFile(result, patch, adapters)).comments[0],
    ).toMatchObject({
      start_line: 1,
      start_side: "RIGHT",
      line: 2,
      side: "RIGHT",
    });
  });

  it.each(["failed" as const, "passed" as const])(
    "never offers failed or skipped files (%s)",
    async (verification) => {
      const result = await process("# old\nrun()\n", commentPlanReply({}));
      result.outputCode = "# change\nrun()\n";
      result.verification = verification;
      if (verification === "passed") result.status = "skipped";
      expect((await reviewFile(result, patch, adapters)).comments).toEqual([]);
    },
  );
});

describe("suggestionBody", () => {
  it("preserves CRLF and trailing blank lines without phantom newline changes", () => {
    expect(suggestionBody("  # why  \r\n\r\nrun()\r\n")).toBe(
      "```suggestion\n  # why  \r\n\r\nrun()\n```",
    );
    expect(suggestionBody("")).toBe("```suggestion\n```");
  });
  it("uses a longer fence when file text contains backticks", () => {
    expect(suggestionBody("# ```\n")).toBe("````suggestion\n# ```\n````");
  });
});
