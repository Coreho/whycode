// Tests for the direct Claude API provider: where its key comes from, the
// model and fallback settings it sends, and how it names itself in errors.
// Shared request and error handling is tested in messages-api.test.ts. The
// live smoke test at the bottom runs only when explicitly enabled.
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import { defaultAdapters } from "../languages/index.js";
import { processFile } from "../pipeline.js";
import {
  claudeApiError,
  createFakeClaudeClient,
  textReply,
} from "../testing/fake-claude-client.js";
import type { ClaudeReply } from "../testing/fake-claude-client.js";
import { createAnthropicProvider } from "./anthropic.js";
import { commentPlanJsonSchema } from "./comment-plan.js";
import { MissingApiKeyError } from "./messages-api.js";
import type { AIRequest } from "./provider.js";

const env = { ANTHROPIC_API_KEY: "sk-ant-api03-" + "k".repeat(40) };
const request: AIRequest = {
  system: "s",
  user: "u",
  jsonSchema: commentPlanJsonSchema,
};

function providerFor(
  model: string,
  outcome: ClaudeReply | Error = textReply("{}"),
) {
  const { client, requests } = createFakeClaudeClient(outcome);
  return {
    provider: createAnthropicProvider({ model, env, client }),
    requests,
  };
}

describe("createAnthropicProvider", () => {
  it("fails before any network call when ANTHROPIC_API_KEY is missing or blank", () => {
    const { client, requests } = createFakeClaudeClient(textReply("{}"));
    expect(() =>
      createAnthropicProvider({ model: "claude-sonnet-5-5", env: {}, client }),
    ).toThrow(MissingApiKeyError);
    expect(() =>
      createAnthropicProvider({
        model: "m",
        env: { ANTHROPIC_API_KEY: "  " },
        client,
      }),
    ).toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(requests).toHaveLength(0);
  });

  it("ignores other credential variables", () => {
    const { client } = createFakeClaudeClient(textReply("{}"));
    const otherKeys = {
      ANTHROPIC_AUTH_TOKEN: "token",
      OPENROUTER_API_KEY: "sk-or-key",
    };
    expect(() =>
      createAnthropicProvider({ model: "m", env: otherKeys, client }),
    ).toThrow(MissingApiKeyError);
  });

  it("sends the configured model unchanged", async () => {
    const { provider, requests } = providerFor("claude-opus-5-5");
    expect(provider.name).toBe("anthropic");
    await provider.complete(request);
    expect(requests[0]?.model).toBe("claude-opus-5-5");
  });

  it("turns on server-side refusal fallback only for models that support it", async () => {
    const sonnet = providerFor("claude-sonnet-5-5");
    await sonnet.provider.complete(request);
    expect(sonnet.requests[0]?.fallbacks).toBe("default");
    expect(sonnet.requests[0]?.betas).toEqual([
      "server-side-fallback-2026-07-01",
    ]);

    const haiku = providerFor("claude-haiku-5-5");
    await haiku.provider.complete(request);
    expect(haiku.requests[0]?.fallbacks).toBeUndefined();
    expect(haiku.requests[0]?.betas).toBeUndefined();
  });

  it("names the Anthropic API and its key variable in errors", async () => {
    const { provider } = providerFor(
      "claude-sonnet-5-5",
      claudeApiError(401, "invalid x-api-key"),
    );
    await expect(provider.complete(request)).rejects.toThrow(
      "the Anthropic API rejected the API key (401). Check ANTHROPIC_API_KEY.",
    );
  });
});

// A real, billed API call. Runs only with an API key AND WHYCODE_LIVE_TESTS=1,
// so a key that happens to be set doesn't make every `pnpm test` cost money.
const liveTestsEnabled =
  Boolean(process.env.ANTHROPIC_API_KEY) &&
  process.env.WHYCODE_LIVE_TESTS === "1";

describe.skipIf(!liveTestsEnabled)("live smoke test (Anthropic)", () => {
  it(
    "comments a small TypeScript file through the real API",
    { timeout: 180_000 },
    async () => {
      const config = resolveConfig();
      const provider = createAnthropicProvider({ model: config.model });
      const code = [
        "export function retryDelay(attempt: number): number {",
        "  return Math.min(30_000, 2 ** attempt * 250);",
        "}",
        "",
      ].join("\n");
      const result = await processFile({ path: "retry.ts", code }, config, {
        provider,
        adapters: defaultAdapters,
      });
      expect(result.status, result.skipReason).not.toBe("skipped");
      expect(result.verification).toBe("passed");
    },
  );
});
