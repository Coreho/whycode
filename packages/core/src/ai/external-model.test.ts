// Tests for running the AI step with a model outside WhyCode: the captured
// request matches what a provider would get, and a reply fed back in goes
// through validation and verification like any provider's.
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import { FakeAIProvider, commentPlanReply } from "../testing/fake-provider.js";
import { createToyAdapter } from "../testing/toy-adapter.js";
import { processFile } from "../pipeline.js";
import {
  captureCommentRequest,
  processWithReply,
  resultFingerprint,
} from "./external-model.js";

const adapters = [createToyAdapter()];
const config = resolveConfig();
const input = { path: "app.toy", code: "start  \nstop\n" };
const plan = commentPlanReply({
  insertions: [{ line: 2, position: "above", text: "Shut down." }],
});

describe("captureCommentRequest", () => {
  it("returns the request a provider would receive", async () => {
    const provider = new FakeAIProvider(plan);
    await processFile(input, config, { provider, adapters });
    const captured = await captureCommentRequest(input, config, adapters);
    expect(captured).toEqual({ ok: true, request: provider.requests[0] });
  });

  it("captures in safe mode even when the config asks for refactor mode", async () => {
    const captured = await captureCommentRequest(
      input,
      resolveConfig({ mode: "refactor" }),
      adapters,
    );
    expect(captured.ok && captured.request.system).toMatch(/never change/);
  });

  it("says why when a file never reaches the AI", async () => {
    expect(
      await captureCommentRequest(
        { path: ".env", code: "A=1" },
        config,
        adapters,
      ),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/never sent to an AI/) as string,
    });
  });
});

describe("processWithReply", () => {
  it("inserts the reply's comments and verifies the result", async () => {
    const result = await processWithReply(input, config, adapters, plan);
    expect(result.outputCode).toBe("start\n# Shut down.\nstop\n");
    expect(result.verification).toBe("passed");
  });

  it("skips the file with the validation error for an invalid reply", async () => {
    const result = await processWithReply(input, config, adapters, "{}");
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toMatch(/invalid reply/);
  });
});

describe("resultFingerprint", () => {
  it("is stable for the same result and changes with the file or the output", async () => {
    const first = await processWithReply(input, config, adapters, plan);
    const again = await processWithReply(input, config, adapters, plan);
    const edited = await processWithReply(
      { ...input, code: "start\nstop\n\n" },
      config,
      adapters,
      plan,
    );
    const noComments = await processWithReply(
      input,
      config,
      adapters,
      commentPlanReply({}),
    );
    expect(resultFingerprint(first)).toBe(resultFingerprint(again));
    expect(resultFingerprint(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(resultFingerprint(edited)).not.toBe(resultFingerprint(first));
    expect(resultFingerprint(noComments)).not.toBe(resultFingerprint(first));
  });

  it("changes when a suggestion's text, target or order changes, though the code doesn't", async () => {
    const withSuggestions = (
      suggestions: { line: number; suggested: string }[],
    ) =>
      processWithReply(
        { path: "app.toy", code: "# one\nstart\n# two\nstop\n" },
        config,
        adapters,
        commentPlanReply({
          existingCommentSuggestions: suggestions.map(
            ({ line, suggested }) => ({
              line,
              original: line === 1 ? "# one" : "# two",
              suggested,
              reason: "clearer",
            }),
          ),
        }),
      );
    const approved = await withSuggestions([
      { line: 1, suggested: "# First." },
      { line: 3, suggested: "# Second." },
    ]);
    const variants = await Promise.all([
      withSuggestions([
        { line: 1, suggested: "# Something else." },
        { line: 3, suggested: "# Second." },
      ]),
      withSuggestions([
        { line: 3, suggested: "# First." },
        { line: 3, suggested: "# Second." },
      ]),
      withSuggestions([
        { line: 3, suggested: "# Second." },
        { line: 1, suggested: "# First." },
      ]),
    ]);
    for (const variant of variants) {
      expect(variant.outputCode).toBe(approved.outputCode);
      expect(resultFingerprint(variant)).not.toBe(resultFingerprint(approved));
    }
  });

  it("changes when verification discarded the comments", async () => {
    const corrupting = [
      createToyAdapter({ corruptOnReformat: (code) => `${code}\nextra` }),
    ];
    const discarded = await processWithReply(input, config, corrupting, plan);
    const passed = await processWithReply(input, config, adapters, plan);
    expect(discarded.verification).toBe("failed");
    expect(resultFingerprint(discarded)).not.toBe(resultFingerprint(passed));
  });
});
