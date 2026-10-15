// Tests for the shared Messages-API provider: the request it builds, how it
// reads replies, and how failures are reported. A fake SDK client stands in
// for the network, and a minimal test backend stands in for a real service.
import Anthropic from "@anthropic-ai/sdk";
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
import { commentPlanJsonSchema } from "./comment-plan.js";
import type { ClaudeClient, MessagesBackend } from "./messages-api.js";
import { buildMessageParams, createMessagesProvider } from "./messages-api.js";
import type { AIRequest } from "./provider.js";

const API_KEY = "sk-test-" + "k".repeat(40);
const request: AIRequest = {
  system: "system prompt",
  user: "user prompt",
  jsonSchema: commentPlanJsonSchema,
};

const testBackend = (client: ClaudeClient): MessagesBackend => ({
  name: "test",
  serviceName: "the Test API",
  keyVariable: "TEST_API_KEY",
  keyDescription: "a test key",
  createClient: () => client,
  modelId: (model) => `vendor/${model}`,
  usesServerSideFallback: () => false,
  statusMessages: { 402: "out of test credits (402)." },
});

function providerFor(outcome: ClaudeReply | Error) {
  const { client, requests } = createFakeClaudeClient(outcome);
  const provider = createMessagesProvider(testBackend(client), {
    model: "model-1",
    env: { TEST_API_KEY: API_KEY },
  });
  return { provider, requests };
}

describe("createMessagesProvider", () => {
  it("names the missing key variable and fails before any request", () => {
    const { client, requests } = createFakeClaudeClient(textReply("{}"));
    expect(() =>
      createMessagesProvider(testBackend(client), { model: "m", env: {} }),
    ).toThrow(
      "TEST_API_KEY is not set. Set it to a test key, or choose a different provider.",
    );
    expect(requests).toHaveLength(0);
  });

  it("sends the backend's model ID and returns the reply text", async () => {
    const { provider, requests } = providerFor(textReply('{"insertions":[]}'));
    expect(provider.name).toBe("test");
    expect(await provider.complete(request)).toBe('{"insertions":[]}');
    expect(requests[0]?.model).toBe("vendor/model-1");
  });

  it("joins the text blocks and ignores thinking blocks", async () => {
    const { provider } = providerFor({
      ...textReply(""),
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "text", text: '{"insertions":', citations: null },
        { type: "text", text: "[]}", citations: null },
      ],
    });
    expect(await provider.complete(request)).toBe('{"insertions":[]}');
  });

  it("reports a refusal instead of returning partial text", async () => {
    const { provider } = providerFor({
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
    await expect(provider.complete(request)).rejects.toThrow(
      "Claude declined to comment on this file (refusal category: cyber).",
    );
  });

  it("reports a reply that was cut off at the token limit", async () => {
    const { provider } = providerFor({
      ...textReply('{"insertions":['),
      stop_reason: "max_tokens",
    });
    await expect(provider.complete(request)).rejects.toThrow(/token limit/);
  });
});

describe("failures become readable messages", () => {
  it.each([
    [
      claudeApiError(401, "invalid key"),
      "the Test API rejected the API key (401). Check TEST_API_KEY.",
    ],
    [
      claudeApiError(403, "forbidden"),
      "this API key is not allowed to use vendor/model-1 (403).",
    ],
    [
      claudeApiError(404, "not found"),
      'model "vendor/model-1" was not found or is not available to this API key (404).',
    ],
    [
      claudeApiError(429, "slow down"),
      "the Test API is rate limiting requests (429), even after retries. Try again later.",
    ],
    [claudeApiError(402, "no credits"), "out of test credits (402)."],
    [
      claudeApiError(500, "overloaded"),
      "the Test API returned an error 500: overloaded",
    ],
    [
      new Anthropic.APIConnectionTimeoutError({
        message: "Request timed out.",
      }),
      "the request to the Test API timed out.",
    ],
    [
      new Anthropic.APIConnectionError({ message: "fetch failed" }),
      "could not reach the Test API. Check the network connection.",
    ],
  ])("%s", async (error, message) => {
    const { provider } = providerFor(error);
    await expect(provider.complete(request)).rejects.toThrow(message);
  });

  it("never lets the API key into an error message", async () => {
    const { provider } = providerFor(
      claudeApiError(400, `bad request for key ${API_KEY}`),
    );
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
    const { provider } = providerFor(claudeApiError(429, "slow down"));
    const result = await processFile(
      { path: "app.ts", code: "const x = 1;\n" },
      resolveConfig(),
      {
        provider,
        adapters: defaultAdapters,
      },
    );
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe(
      'AI provider "test" failed: the Test API is rate limiting requests (429), even after retries. Try again later.',
    );
  });
});

describe("buildMessageParams", () => {
  const noFallback = { serverSideFallback: false };

  it("asks for structured output matching the comment-plan schema", () => {
    const format = buildMessageParams(request, "m", noFallback).output_config
      ?.format;
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
      "m",
      noFallback,
    );
    expect(params.output_config).toBeUndefined();
  });

  it("caches the system prompt, which is shared by every file in a run", () => {
    const params = buildMessageParams(request, "m", noFallback);
    expect(params.system).toEqual([
      {
        type: "text",
        text: "system prompt",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(params.messages).toEqual([{ role: "user", content: "user prompt" }]);
  });

  it("adds server-side refusal fallback only when asked", () => {
    const withFallback = buildMessageParams(request, "m", {
      serverSideFallback: true,
    });
    expect(withFallback.fallbacks).toBe("default");
    expect(withFallback.betas).toEqual(["server-side-fallback-2026-07-01"]);

    const without = buildMessageParams(request, "m", noFallback);
    expect(without.fallbacks).toBeUndefined();
    expect(without.betas).toBeUndefined();
  });
});
