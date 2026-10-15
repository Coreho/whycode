// Tests for the OpenRouter provider: its key, model slugs, the client it
// builds, and its OpenRouter-specific errors. The live smoke test at the
// bottom runs only when explicitly enabled (it makes a real, billed call).
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../config.js";
import { defaultAdapters } from "../languages/index.js";
import { processFile } from "../pipeline.js";
import {
  claudeApiError,
  createFakeClaudeClient,
  textReply,
} from "../testing/fake-claude-client.js";
import type { ClaudeReply } from "../testing/fake-claude-client.js";
import { commentPlanJsonSchema } from "./comment-plan.js";
import { MissingApiKeyError } from "./messages-api.js";
import {
  createOpenRouterClient,
  createOpenRouterProvider,
  OPENROUTER_BASE_URL,
  openRouterModelId,
} from "./openrouter.js";
import type { AIRequest } from "./provider.js";

const OPENROUTER_KEY = "sk-or-v1-" + "a".repeat(64);
const env = { OPENROUTER_API_KEY: OPENROUTER_KEY };
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
    provider: createOpenRouterProvider({ model, env, client }),
    requests,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createOpenRouterProvider", () => {
  it("reads the key only from OPENROUTER_API_KEY and fails before any request", () => {
    const { client, requests } = createFakeClaudeClient(textReply("{}"));
    expect(() =>
      createOpenRouterProvider({
        model: "m",
        env: { ANTHROPIC_API_KEY: "sk-ant-x" },
        client,
      }),
    ).toThrow(MissingApiKeyError);
    expect(() =>
      createOpenRouterProvider({ model: "m", env: {}, client }),
    ).toThrow(
      "OPENROUTER_API_KEY is not set. Set it to an OpenRouter API key, or choose a different provider.",
    );
    expect(requests).toHaveLength(0);
  });

  it("sends OpenRouter's slug for the configured model", async () => {
    const { provider, requests } = providerFor("claude-sonnet-5-5");
    expect(provider.name).toBe("openrouter");
    await provider.complete(request);
    expect(requests[0]?.model).toBe("anthropic/claude-sonnet-5.5");
  });

  it("never sends Anthropic's server-side fallback parameters", async () => {
    const { provider, requests } = providerFor("claude-sonnet-5-5");
    await provider.complete(request);
    expect(requests[0]?.fallbacks).toBeUndefined();
    expect(requests[0]?.betas).toBeUndefined();
  });

  it("still asks for structured output and caches the system prompt", async () => {
    const { provider, requests } = providerFor("claude-sonnet-5-5");
    await provider.complete(request);
    expect(requests[0]?.output_config?.format?.type).toBe("json_schema");
    expect(requests[0]?.system).toEqual([
      { type: "text", text: "s", cache_control: { type: "ephemeral" } },
    ]);
  });
});

describe("openRouterModelId", () => {
  it.each([
    ["claude-sonnet-5-5", "anthropic/claude-sonnet-5.5"],
    ["claude-opus-5-5", "anthropic/claude-opus-5.5"],
    ["claude-fable-5-1", "anthropic/claude-fable-5.1"],
    ["claude-haiku-4-5", "anthropic/claude-haiku-4.5"],
    ["claude-opus-5", "anthropic/claude-opus-5"],
    ["anthropic/claude-sonnet-5.5", "anthropic/claude-sonnet-5.5"],
    ["openai/gpt-5", "openai/gpt-5"],
  ])("%s becomes %s", (model, slug) => {
    expect(openRouterModelId(model)).toBe(slug);
  });
});

describe("createOpenRouterClient", () => {
  it("points the SDK at OpenRouter and sends the key as a bearer token", () => {
    const client = createOpenRouterClient(OPENROUTER_KEY);
    expect(client.baseURL).toBe(OPENROUTER_BASE_URL);
    expect(client.authToken).toBe(OPENROUTER_KEY);
    expect(client.apiKey).toBeNull();
  });

  it("never picks up an Anthropic key from the environment", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-should-not-be-sent");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://example.invalid");
    const client = createOpenRouterClient(OPENROUTER_KEY);
    expect(client.apiKey).toBeNull();
    expect(client.baseURL).toBe(OPENROUTER_BASE_URL);
  });
});

describe("OpenRouter errors", () => {
  it.each([
    [
      claudeApiError(401, "No auth credentials found"),
      "OpenRouter rejected the API key (401). Check OPENROUTER_API_KEY.",
    ],
    [
      claudeApiError(402, "Insufficient credits"),
      /the OpenRouter account is out of credits \(402\)/,
    ],
    [
      claudeApiError(429, "Rate limit exceeded"),
      "OpenRouter is rate limiting requests (429)",
    ],
  ])("%s", async (error, message) => {
    const { provider } = providerFor("claude-sonnet-5-5", error);
    await expect(provider.complete(request)).rejects.toThrow(message);
  });

  it("keeps the OpenRouter key out of skip reasons", async () => {
    const { provider } = providerFor(
      "claude-sonnet-5-5",
      claudeApiError(400, `invalid request with key ${OPENROUTER_KEY}`),
    );
    const result = await processFile(
      { path: "app.ts", code: "const x = 1;\n" },
      resolveConfig(),
      {
        provider,
        adapters: defaultAdapters,
      },
    );
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toMatch(
      /^AI provider "openrouter" failed: OpenRouter returned an error 400/,
    );
    expect(result.skipReason).not.toContain(OPENROUTER_KEY);
  });
});

// A real, billed call through OpenRouter. Runs only with OPENROUTER_API_KEY
// AND WHYCODE_LIVE_TESTS=1.
const liveTestsEnabled =
  Boolean(process.env.OPENROUTER_API_KEY) &&
  process.env.WHYCODE_LIVE_TESTS === "1";

describe.skipIf(!liveTestsEnabled)("live smoke test (OpenRouter)", () => {
  it(
    "comments a small TypeScript file through OpenRouter",
    { timeout: 180_000 },
    async () => {
      const config = resolveConfig({ provider: "openrouter" });
      const provider = createOpenRouterProvider({ model: config.model });
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
