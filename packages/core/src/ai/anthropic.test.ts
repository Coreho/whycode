// Tests for the Claude API provider. A fake client stands in for the SDK, so
// these tests never touch the network. The live smoke test at the bottom runs
// only when explicitly enabled (it makes a real, billed API call).
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import { defaultAdapters } from "../languages/index.js";
import { processFile } from "../pipeline.js";
import type { ClaudeClient } from "./anthropic.js";
import {
  buildMessageParams,
  createAnthropicProvider,
  MissingApiKeyError,
} from "./anthropic.js";
import { commentPlanJsonSchema } from "./comment-plan.js";
import type { AIRequest } from "./provider.js";

const API_KEY = "sk-ant-api03-" + "k".repeat(40);
const env = { ANTHROPIC_API_KEY: API_KEY };
const request: AIRequest = {
  system: "system prompt",
  user: "user prompt",
  jsonSchema: commentPlanJsonSchema,
};

type StreamParams = Parameters<ClaudeClient["beta"]["messages"]["stream"]>[0];
type Reply = Awaited<
  ReturnType<
    ReturnType<ClaudeClient["beta"]["messages"]["stream"]>["finalMessage"]
  >
>;

const textReply = (text: string): Reply => ({
  content: [{ type: "text", text, citations: null }],
  stop_reason: "end_turn",
  stop_details: null,
});

/** A fake SDK client that records requests and replies (or fails) as scripted. */
function fakeClient(outcome: Reply | Error) {
  const requests: StreamParams[] = [];
  const client: ClaudeClient = {
    beta: {
      messages: {
        stream(params) {
          requests.push(params);
          return {
            finalMessage: () =>
              outcome instanceof Error
                ? Promise.reject(outcome)
                : Promise.resolve(outcome),
          };
        },
      },
    },
  };
  return { client, requests };
}

const apiError = (status: number, message: string) =>
  Anthropic.APIError.generate(
    status,
    { type: "error", error: { message } },
    message,
    new Headers(),
  );

describe("createAnthropicProvider", () => {
  it("fails before any network call when ANTHROPIC_API_KEY is missing or blank", () => {
    const { client, requests } = fakeClient(textReply("{}"));
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
    const { client } = fakeClient(textReply("{}"));
    expect(() =>
      createAnthropicProvider({
        model: "m",
        env: { ANTHROPIC_AUTH_TOKEN: "token" },
        client,
      }),
    ).toThrow(MissingApiKeyError);
  });

  it("returns the text of Claude's reply", async () => {
    const { client } = fakeClient(textReply('{"insertions":[]}'));
    const provider = createAnthropicProvider({
      model: "claude-sonnet-5-5",
      env,
      client,
    });
    expect(provider.name).toBe("anthropic");
    expect(await provider.complete(request)).toBe('{"insertions":[]}');
  });

  it("sends the configured model", async () => {
    const { client, requests } = fakeClient(textReply("{}"));
    await createAnthropicProvider({
      model: "claude-opus-5-5",
      env,
      client,
    }).complete(request);
    expect(requests[0]?.model).toBe("claude-opus-5-5");
  });

  it("reports a refusal instead of returning partial text", async () => {
    const { client } = fakeClient({
      content: [],
      stop_reason: "refusal",
      stop_details: {
        type: "refusal",
        category: "cyber",
        explanation: null,
        fallback_credit_token: null,
        fallback_has_prefill_claim: false,
        recommended_model: null,
      },
    });
    const provider = createAnthropicProvider({
      model: "claude-sonnet-5-5",
      env,
      client,
    });
    await expect(provider.complete(request)).rejects.toThrow(
      "Claude declined to comment on this file (refusal category: cyber).",
    );
  });

  it("reports a reply that was cut off at the token limit", async () => {
    const { client } = fakeClient({
      ...textReply('{"insertions":['),
      stop_reason: "max_tokens",
    });
    const provider = createAnthropicProvider({
      model: "claude-sonnet-5-5",
      env,
      client,
    });
    await expect(provider.complete(request)).rejects.toThrow(/token limit/);
  });
});

describe("API failures become readable messages", () => {
  it.each([
    [apiError(401, "invalid x-api-key"), /rejected the API key \(401\)/],
    [
      apiError(403, "forbidden"),
      /not allowed to use claude-sonnet-5-5 \(403\)/,
    ],
    [
      apiError(404, "model: claude-sonnet-5-5"),
      /was not found or is not available/,
    ],
    [apiError(429, "rate_limit_error"), /rate limiting requests \(429\)/],
    [apiError(500, "overloaded"), /Anthropic API error 500/],
    [
      new Anthropic.APIConnectionTimeoutError({
        message: "Request timed out.",
      }),
      /timed out/,
    ],
    [
      new Anthropic.APIConnectionError({ message: "fetch failed" }),
      /could not reach the Anthropic API/,
    ],
  ])("%s", async (error, message) => {
    const { client } = fakeClient(error);
    const provider = createAnthropicProvider({
      model: "claude-sonnet-5-5",
      env,
      client,
    });
    await expect(provider.complete(request)).rejects.toThrow(message);
  });

  it("never lets the API key into an error message", async () => {
    const { client } = fakeClient(
      apiError(400, `bad request for key ${API_KEY}`),
    );
    const provider = createAnthropicProvider({
      model: "claude-sonnet-5-5",
      env,
      client,
    });
    const failure = await provider
      .complete(request)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const thrown = failure as Error;
    expect(thrown.message).not.toContain(API_KEY);
    expect(thrown.message).toContain("[REDACTED]");
    expect(thrown).not.toHaveProperty("cause");
    expect(
      JSON.stringify(thrown, Object.getOwnPropertyNames(thrown)),
    ).not.toContain(API_KEY);
  });

  it("skips the file with the readable reason instead of stopping the run", async () => {
    const { client } = fakeClient(apiError(429, "rate_limit_error"));
    const provider = createAnthropicProvider({
      model: "claude-sonnet-5-5",
      env,
      client,
    });
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
      /^AI provider "anthropic" failed: the Anthropic API is rate limiting/,
    );
  });
});

describe("buildMessageParams", () => {
  it("asks for structured output matching the comment-plan schema", () => {
    const params = buildMessageParams(request, "claude-sonnet-5-5");
    const format = params.output_config?.format;
    expect(format?.type).toBe("json_schema");
    const schema = JSON.stringify(format?.schema);
    expect(schema).toContain('"insertions"');
    expect(schema).toContain('"additionalProperties":false');
    // Constraints the API can't enforce are removed; zod still checks them.
    expect(schema).not.toContain('"minLength"');
    expect(schema).not.toContain('"minimum"');
  });

  it("leaves out structured output when no schema is given", () => {
    const params = buildMessageParams(
      { system: "s", user: "u" },
      "claude-sonnet-5-5",
    );
    expect(params.output_config).toBeUndefined();
  });

  it("caches the system prompt, which is shared by every file in a run", () => {
    const params = buildMessageParams(request, "claude-sonnet-5-5");
    expect(params.system).toEqual([
      {
        type: "text",
        text: "system prompt",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(params.messages).toEqual([{ role: "user", content: "user prompt" }]);
  });

  it("turns on server-side refusal fallback only for models that support it", () => {
    const sonnet = buildMessageParams(request, "claude-sonnet-5-5");
    expect(sonnet.fallbacks).toBe("default");
    expect(sonnet.betas).toEqual(["server-side-fallback-2026-07-01"]);

    const haiku = buildMessageParams(request, "claude-haiku-5-5");
    expect(haiku.fallbacks).toBeUndefined();
    expect(haiku.betas).toBeUndefined();
  });
});

// A real, billed API call. Runs only with an API key AND WHYCODE_LIVE_TESTS=1,
// so a key that happens to be set doesn't make every `pnpm test` cost money.
const liveTestsEnabled =
  Boolean(process.env.ANTHROPIC_API_KEY) &&
  process.env.WHYCODE_LIVE_TESTS === "1";

describe.skipIf(!liveTestsEnabled)("live smoke test", () => {
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
