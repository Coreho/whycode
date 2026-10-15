// Tests for the per-file verdict: every outcome gets its own wording, and
// the wording only claims what is checked.
import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import type { FileInput, PipelineDeps } from "./pipeline.js";
import { processFile } from "./pipeline.js";
import { commentPlanReply, FakeAIProvider } from "./testing/fake-provider.js";
import type { FakeResponse } from "./testing/fake-provider.js";
import type { ToyAdapterOptions } from "./testing/toy-adapter.js";
import { createToyAdapter } from "./testing/toy-adapter.js";
import { fileVerdict } from "./verdict.js";

const comment = (line: number, text: string) =>
  commentPlanReply({ insertions: [{ line, position: "above", text }] });

async function verdictFor(
  input: FileInput,
  reply: FakeResponse,
  adapter: ToyAdapterOptions = {},
  mode: "safe" | "refactor" = "safe",
) {
  const deps: PipelineDeps = {
    provider: new FakeAIProvider(reply),
    adapters: [createToyAdapter(adapter)],
  };
  return fileVerdict(await processFile(input, resolveConfig({ mode }), deps));
}

const tidy = { path: "a.toy", code: "start\nstop\n" };

describe("fileVerdict", () => {
  it("says nothing needs changing", async () => {
    expect(await verdictFor(tidy, commentPlanReply({}))).toEqual({
      kind: "unchanged",
      text: "nothing to change",
    });
  });

  it("counts added comments and claims only token preservation", async () => {
    const verdict = await verdictFor(tidy, comment(2, "Shut down."));
    expect(verdict).toEqual({
      kind: "verified",
      text: "1 comment added; comment insertion preserved the checked code tokens",
    });
  });

  it("calls out formatting-only results", async () => {
    const messy = { path: "a.toy", code: "start   \nstop\n" };
    expect((await verdictFor(messy, commentPlanReply({}))).text).toBe(
      "formatting only (no comments were needed)",
    );
  });

  it("reports discarded comments even when nothing else changes", async () => {
    const verdict = await verdictFor(tidy, comment(2, "Shut down."), {
      corruptOnReformat: (code) => `${code}\nextra`,
    });
    expect(verdict).toEqual({
      kind: "discarded",
      text: "comments discarded because verification failed; nothing else to change",
    });
  });

  it("never calls comments in an unsupported language verified", async () => {
    const verdict = await verdictFor(
      { path: "a.rb", code: "puts 1\n" },
      comment(1, "Print one."),
    );
    expect(verdict).toEqual({
      kind: "unverified",
      text: "1 comment added without verification (no full support for ruby)",
    });
  });

  it("warns that a refactor may change logic", async () => {
    const rewrite = JSON.stringify({ code: "finish\n", changes: ["Renamed."] });
    const verdict = await verdictFor(tidy, rewrite, {}, "refactor");
    expect(verdict.kind).toBe("refactored");
    expect(verdict.text).toMatch(/logic may change/);
  });

  it("reports failures with the reason", async () => {
    const verdict = await verdictFor(tidy, new Error("rate limited"));
    expect(verdict.kind).toBe("failed");
    expect(verdict.text).toMatch(/^not processed: .*rate limited/);
  });

  it("mentions suggestions for existing comments", async () => {
    const reply = commentPlanReply({
      existingCommentSuggestions: [
        { line: 1, original: "# old", suggested: "# New.", reason: "r" },
      ],
    });
    const verdict = await verdictFor(
      { path: "a.toy", code: "# old\nstart\n" },
      reply,
    );
    expect(verdict.text).toBe(
      "nothing to change; 1 suggested rewrite of existing comments to review",
    );
  });
});
