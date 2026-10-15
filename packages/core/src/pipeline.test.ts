// End-to-end tests of the per-file pipeline, run offline with the fake AI
// provider and the toy language adapter.
import { describe, expect, it } from "vitest";
import type {
  CommentInsertion,
  ExistingCommentSuggestion,
} from "./ai/comment-plan.js";
import { resolveConfig } from "./config.js";
import type { LanguageAdapter } from "./languages/adapter.js";
import type { FileInput, PipelineDeps } from "./pipeline.js";
import { processFile } from "./pipeline.js";
import { commentPlanReply, FakeAIProvider } from "./testing/fake-provider.js";
import type { FakeResponse } from "./testing/fake-provider.js";
import { createToyAdapter } from "./testing/toy-adapter.js";

const config = resolveConfig();

const above = (line: number, text: string): CommentInsertion => ({
  line,
  position: "above",
  text,
});

const cartCode = [
  "fn total items",
  "  sum = add items",
  "  # existing note",
  "  return sum",
  "",
].join("\n");

function setup(
  responses: FakeResponse | FakeResponse[],
  adapter: LanguageAdapter = createToyAdapter(),
) {
  const provider = new FakeAIProvider(responses);
  const deps: PipelineDeps = { provider, adapters: [adapter] };
  const run = (input: FileInput, runConfig = config) =>
    processFile(input, runConfig, deps);
  return { provider, run };
}

describe("processFile: happy path", () => {
  const suggestion: ExistingCommentSuggestion = {
    line: 3,
    original: "# existing note",
    suggested: "# Sum of all item prices.",
    reason: "More specific.",
  };

  it("inserts comments, verifies them, and passes suggestions through", async () => {
    const { provider, run } = setup(
      commentPlanReply({
        insertions: [
          above(1, "Adds up the items."),
          above(4, "Callers expect a number."),
        ],
        existingCommentSuggestions: [suggestion],
      }),
    );

    const result = await run({ path: "src/cart.toy", code: cartCode });

    expect(result).toMatchObject({
      status: "changed",
      languageId: "toy",
      mode: "full",
      formatted: true,
      verification: "passed",
      warnings: [],
    });
    expect(result.outputCode).toBe(
      [
        "# Adds up the items.",
        "fn total items",
        "  sum = add items",
        "  # existing note",
        "  # Callers expect a number.",
        "  return sum",
        "",
      ].join("\n"),
    );
    expect(result.diff).toContain("+# Adds up the items.");
    // The existing comment moved from line 3 to line 4.
    expect(result.commentSuggestions).toEqual([{ ...suggestion, line: 4 }]);
    expect(provider.requests[0]?.user).toContain("1| fn total items");
  });

  it("reports an already-clean file with no comments as unchanged", async () => {
    const { run } = setup(commentPlanReply({}));
    const result = await run({ path: "cart.toy", code: cartCode });
    expect(result.status).toBe("unchanged");
    expect(result.diff).toBe("");
    expect(result.outputCode).toBe(cartCode);
  });

  it("keeps formatting changes even when the AI adds no comments", async () => {
    const { run } = setup(commentPlanReply({}));
    const result = await run({
      path: "cart.toy",
      code: "fn f   \n\n\n  return 1\n",
    });
    expect(result.status).toBe("changed");
    expect(result.outputCode).toBe("fn f\n\n  return 1\n");
  });
});

describe("processFile: AI failures", () => {
  it("retries once after an invalid reply", async () => {
    const { provider, run } = setup([
      "not json",
      commentPlanReply({ insertions: [above(1, "Hi.")] }),
    ]);
    const result = await run({ path: "cart.toy", code: cartCode });
    expect(result.status).toBe("changed");
    expect(provider.requests).toHaveLength(2);
  });

  it("tells the model what was wrong on the retry, keeping the system prompt", async () => {
    const { provider, run } = setup([
      '{"insertions": [{"line": "two"}]}',
      commentPlanReply({ insertions: [above(1, "Hi.")] }),
    ]);
    await run({ path: "cart.toy", code: cartCode });
    const [first, retry] = provider.requests;
    expect(retry?.system).toBe(first?.system);
    expect(retry?.jsonSchema).toEqual(first?.jsonSchema);
    expect(retry?.user.startsWith(first?.user ?? "?")).toBe(true);
    expect(retry?.user).toMatch(
      /Your previous reply could not be used: .*insertions/s,
    );
    expect(retry?.user).toMatch(/Reply again with only the JSON object/);
  });

  it("skips the file after two invalid replies", async () => {
    const { provider, run } = setup("not json");
    const result = await run({ path: "cart.toy", code: cartCode });
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toMatch(/invalid reply 2 times/);
    expect(result.outputCode).toBe(cartCode);
    expect(provider.requests).toHaveLength(2);
  });

  it("skips the file when the provider throws", async () => {
    const { provider, run } = setup(new Error("network down"));
    const result = await run({ path: "cart.toy", code: cartCode });
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toMatch(/network down/);
    expect(provider.requests).toHaveLength(1);
  });

  it("drops comments and suggestions aimed past the end of the file", async () => {
    const { run } = setup(
      commentPlanReply({
        insertions: [above(99, "Lost.")],
        existingCommentSuggestions: [
          { line: 99, original: "# old", suggested: "# new", reason: "" },
        ],
      }),
    );
    const result = await run({ path: "cart.toy", code: cartCode });
    expect(result.status).toBe("unchanged");
    expect(result.commentSuggestions).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });
});

describe("processFile: verification", () => {
  it("discards AI changes when the code's tokens change, keeping formatting", async () => {
    const buggyFormatter = createToyAdapter({
      corruptOnReformat: (code) => code.replace("add", "subtract"),
    });
    const { run } = setup(
      commentPlanReply({ insertions: [above(1, "Hi.")] }),
      buggyFormatter,
    );

    const result = await run({
      path: "cart.toy",
      code: cartCode.replace("items", "items   "),
    });

    expect(result.verification).toBe("failed");
    expect(result.status).toBe("changed");
    expect(result.outputCode).toBe(cartCode);
    expect(result.diff).not.toContain("+# Hi.");
    expect(result.warnings[0]).toMatch(
      /discarded.*expected "add", found "subtract"/,
    );
  });

  it("warns and continues when the formatter is not installed", async () => {
    const noFormatter = createToyAdapter({ formatterAvailable: false });
    const { run } = setup(
      commentPlanReply({ insertions: [above(1, "Hi.")] }),
      noFormatter,
    );
    const result = await run({ path: "cart.toy", code: cartCode });
    expect(result.formatted).toBe(false);
    expect(result.verification).toBe("passed");
    expect(result.warnings).toEqual([
      "No formatter available for toy; formatting was skipped.",
    ]);
  });

  it("discards AI changes when the formatter rejects the code after insertion", async () => {
    const rejectsCommentedCode = createToyAdapter({
      corruptOnReformat: () => {
        throw new Error("unexpected comment on line 1");
      },
    });
    const { run } = setup(
      commentPlanReply({ insertions: [above(1, "Hi.")] }),
      rejectsCommentedCode,
    );

    const result = await run({ path: "cart.toy", code: cartCode });

    expect(result.status).toBe("unchanged");
    expect(result.verification).toBe("failed");
    expect(result.outputCode).toBe(cartCode);
    expect(result.warnings[0]).toMatch(
      /discarded because the formatter rejected the code after they were inserted \(unexpected comment on line 1\)/,
    );
  });

  it("skips the file when the formatter throws", async () => {
    const brokenFormatter: LanguageAdapter = {
      ...createToyAdapter(),
      format: () => Promise.reject(new Error("syntax error on line 2")),
    };
    const { run } = setup(commentPlanReply({}), brokenFormatter);
    const result = await run({ path: "cart.toy", code: cartCode });
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("processing failed: syntax error on line 2");
  });
});

describe("processFile: language detection", () => {
  it("handles unsupported-but-known languages in comments-only mode", async () => {
    const { run } = setup(
      commentPlanReply({ insertions: [above(1, "Greets the user.")] }),
    );
    const result = await run({
      path: "script.rb",
      code: "def hi\n  puts 'hi'\nend\n",
    });
    expect(result).toMatchObject({
      status: "changed",
      languageId: "ruby",
      mode: "comments-only",
      formatted: false,
      verification: "not-run",
    });
    expect(result.outputCode).toBe(
      "# Greets the user.\ndef hi\n  puts 'hi'\nend\n",
    );
    expect(result.warnings[0]).toMatch(/no full support yet/);
  });

  it("skips unknown file types without calling the AI", async () => {
    const { provider, run } = setup(commentPlanReply({}));
    const result = await run({ path: "data.xyz", code: "whatever" });
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe('unsupported file type ".xyz"');
    expect(result.languageId).toBeNull();
    expect(provider.requests).toHaveLength(0);
  });
});

describe("processFile: privacy", () => {
  it.each([".env", "config/.env.local", "certs/server.pem"])(
    "never sends %s to the AI",
    async (path) => {
      const { provider, run } = setup(commentPlanReply({}));
      const result = await run({ path, code: "API_KEY=abc123" });
      expect(result.status).toBe("skipped");
      expect(result.skipReason).toMatch(/never sent to an AI/);
      expect(provider.requests).toHaveLength(0);
    },
  );

  it("masks secrets in what the AI sees but keeps them in the output", async () => {
    const secret = "sk-ant-" + "q".repeat(32);
    const code = `fn connect\n  key = "${secret}"\n`;
    const { provider, run } = setup(
      commentPlanReply({ insertions: [above(1, "Opens a session.")] }),
    );

    const result = await run({ path: "client.toy", code });

    const sentToAi = provider.requests[0]?.user ?? "";
    expect(sentToAi).not.toContain(secret);
    expect(sentToAi).toContain("[REDACTED]");
    expect(result.outputCode).toContain(secret);
    expect(result.warnings).toContain(
      "1 likely secret(s) were masked before the code was sent to the AI.",
    );
  });
});

describe("processFile: other behavior", () => {
  it("drops suggestions that are empty or change nothing", async () => {
    // The empty entry reproduces one seen in a real run on nudl.
    const { run } = setup(
      commentPlanReply({
        existingCommentSuggestions: [
          { line: 2, original: "", suggested: "", reason: "none" },
          { line: 1, original: "# same", suggested: " # same ", reason: "x" },
          { line: 1, original: "# old", suggested: "", reason: "x" },
        ],
      }),
    );
    const result = await run({ path: "cart.toy", code: cartCode });
    expect(result.commentSuggestions).toEqual([]);
  });

  it("preserves CRLF line endings", async () => {
    const { run } = setup(
      commentPlanReply({ insertions: [above(1, "Adds up the items.")] }),
    );
    const crlfCode = cartCode.replace(/\n/g, "\r\n");

    const result = await run({ path: "cart.toy", code: crlfCode });

    expect(
      result.outputCode.startsWith(
        "# Adds up the items.\r\nfn total items\r\n",
      ),
    ).toBe(true);
    expect(/[^\r]\n/.test(result.outputCode)).toBe(false);
    expect(result.diff).not.toContain("\r");
  });

  it("keeps a byte-order mark first, even with a comment above line 1", async () => {
    const bom = String.fromCharCode(0xfeff);
    const { run } = setup(
      commentPlanReply({ insertions: [above(1, "Adds up the items.")] }),
    );

    const result = await run({ path: "cart.toy", code: bom + cartCode });

    expect(result.outputCode.startsWith(`${bom}# Adds up the items.\n`)).toBe(
      true,
    );
    expect(result.outputCode.indexOf(bom, 1)).toBe(-1);
    expect(result.diff).not.toContain(bom);
  });
});
