// Claude API provider: the API-key path the CLI and GitHub Action use.
// Sends the comment-pass prompt to Claude with structured output, and turns
// API failures into readable messages that never contain the API key.
import Anthropic from "@anthropic-ai/sdk";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import { redactSecrets } from "../privacy.js";
import type { AIProvider, AIRequest } from "./provider.js";

// Derived from the SDK method itself, so it always matches the installed SDK.
type MessageParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];
type Reply = Pick<
  Anthropic.Beta.Messages.BetaMessage,
  "content" | "stop_reason" | "stop_details"
>;

/** The slice of the SDK client this provider uses, so tests can supply a fake. */
export interface ClaudeClient {
  beta: {
    messages: {
      stream(params: MessageParams): { finalMessage(): Promise<Reply> };
    };
  };
}

export interface AnthropicProviderOptions {
  model: string;
  /** Where to read ANTHROPIC_API_KEY from. Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Replaces the SDK client; used by tests. */
  client?: ClaudeClient;
}

export class MissingApiKeyError extends Error {
  override name = "MissingApiKeyError";
}

// Streaming avoids HTTP timeouts on long files, so the reply can be given
// plenty of room: adaptive thinking also counts against this limit.
const MAX_TOKENS = 64_000;

// Models that accept server-side refusal fallback ("default" routing). If the
// model declines a file for a safety reason, the API retries it on another
// model instead of returning the refusal. Other models get no fallback.
const SERVER_SIDE_FALLBACK_MODELS: ReadonlySet<string> = new Set([
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Creates the provider. The key comes only from ANTHROPIC_API_KEY, and a
 * missing key fails here, before any network call is made.
 */
export function createAnthropicProvider(
  options: AnthropicProviderOptions,
): AIProvider {
  const apiKey = (options.env ?? process.env).ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new MissingApiKeyError(
      "ANTHROPIC_API_KEY is not set. Set it to an Anthropic API key, or use the host provider to rely on your editor's AI.",
    );
  }
  // authToken: null stops the SDK from also sending ANTHROPIC_AUTH_TOKEN,
  // which would make the API reject the request.
  const client = options.client ?? new Anthropic({ apiKey, authToken: null });

  return {
    name: "anthropic",
    async complete(request) {
      try {
        const reply = await client.beta.messages
          .stream(buildMessageParams(request, options.model))
          .finalMessage();
        return replyText(reply);
      } catch (error) {
        // The original error is deliberately not attached as `cause`: it can
        // carry request details, and the API key must never leave this module.
        // eslint-disable-next-line preserve-caught-error -- see comment above
        throw new Error(
          withoutSecrets(describeFailure(error, options.model), apiKey),
        );
      }
    },
  };
}

/** The Messages API request for one comment-pass request. Exported for tests. */
export function buildMessageParams(
  request: AIRequest,
  model: string,
): MessageParams {
  const params: MessageParams = {
    model,
    max_tokens: MAX_TOKENS,
    // The system prompt is the same for every file in a run, so cache it.
    system: [
      {
        type: "text",
        text: request.system,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: request.user }],
  };
  if (request.jsonSchema !== undefined) {
    // The SDK's transform drops schema features the API can't enforce;
    // the pipeline still validates every reply with the full zod schema.
    const schema = transformJSONSchema(request.jsonSchema) as Record<
      string,
      unknown
    >;
    params.output_config = { format: { type: "json_schema", schema } };
  }
  if (SERVER_SIDE_FALLBACK_MODELS.has(model)) {
    params.betas = [SERVER_SIDE_FALLBACK_BETA];
    params.fallbacks = "default";
  }
  return params;
}

/** Joins the reply's text blocks, or throws if the model refused or was cut off. */
function replyText(reply: Reply): string {
  if (reply.stop_reason === "refusal") {
    const category = reply.stop_details?.category;
    const detail = category ? ` (refusal category: ${category})` : "";
    throw new Error(`Claude declined to comment on this file${detail}.`);
  }
  if (reply.stop_reason === "max_tokens") {
    throw new Error(
      `Claude's reply hit the ${MAX_TOKENS}-token limit before finishing.`,
    );
  }
  return reply.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}

/** A readable reason for a failed request, most specific error class first. */
function describeFailure(error: unknown, model: string): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "the Anthropic API rejected the API key (401). Check ANTHROPIC_API_KEY.";
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return `this API key is not allowed to use ${model} (403).`;
  }
  if (error instanceof Anthropic.NotFoundError) {
    return `model "${model}" was not found or is not available to this API key (404).`;
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "the Anthropic API is rate limiting requests (429), even after retries. Try again later.";
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return "the request to the Anthropic API timed out.";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "could not reach the Anthropic API. Check the network connection.";
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status === undefined ? "" : ` ${error.status}`;
    return `Anthropic API error${status}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Removes the API key, and anything else that looks like a secret, from a message. */
function withoutSecrets(message: string, apiKey: string): string {
  return redactSecrets(message.split(apiKey).join("[REDACTED]")).code;
}
