// A stand-in for the Anthropic SDK client, so providers that speak the
// Messages API (Anthropic, OpenRouter) can be tested without the network.
import Anthropic from "@anthropic-ai/sdk";
import type { ClaudeClient } from "../ai/messages-api.js";

type Stream = ClaudeClient["beta"]["messages"]["stream"];
export type ClaudeRequestParams = Parameters<Stream>[0];
export type ClaudeReply = Awaited<
  ReturnType<ReturnType<Stream>["finalMessage"]>
>;

/** A normal reply holding one text block. */
export function textReply(text: string): ClaudeReply {
  return {
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_details: null,
  };
}

/** A fake client that records every request and replies (or fails) as scripted. */
export function createFakeClaudeClient(outcome: ClaudeReply | Error): {
  client: ClaudeClient;
  requests: ClaudeRequestParams[];
} {
  const requests: ClaudeRequestParams[] = [];
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

/** The error the SDK throws for an HTTP error status, e.g. 401 or 429. */
export function claudeApiError(status: number, message: string): Error {
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { message } },
    message,
    new Headers(),
  );
}
