// Shared provider for services that speak the Anthropic Messages API: the
// Claude API itself and OpenRouter's Anthropic-compatible endpoint. Each
// service describes itself as a MessagesBackend; this module does the rest:
// building the request, reading the reply, and turning failures into
// readable messages that never contain the API key.
import Anthropic from "@anthropic-ai/sdk";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import { redactSecrets } from "../privacy.js";
import { withoutHiddenCharacters } from "../text.js";
import type { AIProvider, AIRequest } from "./provider.js";

// Derived from the SDK method itself, so it always matches the installed SDK.
type MessageParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];
type Reply = Pick<
  Anthropic.Beta.Messages.BetaMessage,
  "content" | "stop_reason" | "stop_details"
>;

/** The slice of the SDK client a provider uses, so tests can supply a fake. */
export interface ClaudeClient {
  beta: {
    messages: {
      stream(params: MessageParams): { finalMessage(): Promise<Reply> };
    };
  };
}

/** What differs between services that speak the Messages API. */
export interface MessagesBackend {
  /** Provider name, shown in skip reasons. */
  name: string;
  /** How messages refer to the service, e.g. "the Anthropic API". */
  serviceName: string;
  /** The only environment variable the key is read from. */
  keyVariable: string;
  /** What the key is, for the missing-key message, e.g. "an Anthropic API key". */
  keyDescription: string;
  createClient(apiKey: string): ClaudeClient;
  /** Turns the model from config into the ID this service expects. */
  modelId(model: string): string;
  /** Whether a request for this model may use Anthropic's server-side refusal fallback. */
  usesServerSideFallback(modelId: string): boolean;
  /** Readable messages for HTTP statuses specific to this service. */
  statusMessages?: Readonly<Record<number, string>>;
}

export interface MessagesProviderOptions {
  model: string;
  /** Where to read the key from. Defaults to process.env. */
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
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Creates a provider for one backend. The key comes only from the backend's
 * key variable, and a missing key fails here, before any network call.
 */
export function createMessagesProvider(
  backend: MessagesBackend,
  options: MessagesProviderOptions,
): AIProvider {
  const apiKey = (options.env ?? process.env)[backend.keyVariable]?.trim();
  if (!apiKey) {
    throw new MissingApiKeyError(
      `${backend.keyVariable} is not set. Set it to ${backend.keyDescription}, or choose a different provider.`,
    );
  }
  const client = options.client ?? backend.createClient(apiKey);
  const modelId = backend.modelId(options.model);
  const serverSideFallback = backend.usesServerSideFallback(modelId);

  return {
    name: backend.name,
    async complete(request) {
      try {
        const params = buildMessageParams(request, modelId, {
          serverSideFallback,
        });
        return replyText(
          await client.beta.messages.stream(params).finalMessage(),
        );
      } catch (error) {
        // The original error is deliberately not attached as `cause`: it can
        // carry request details, and the API key must never leave this module.
        // eslint-disable-next-line preserve-caught-error -- see comment above
        throw new Error(
          withoutSecrets(describeFailure(error, backend, modelId), apiKey),
        );
      }
    },
  };
}

/** The Messages API request for one comment-pass request. Exported for tests. */
export function buildMessageParams(
  request: AIRequest,
  modelId: string,
  { serverSideFallback }: { serverSideFallback: boolean },
): MessageParams {
  const params: MessageParams = {
    model: modelId,
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
  if (serverSideFallback) {
    // If the model declines a file for a safety reason, the API retries it
    // on the model Anthropic recommends for that kind of refusal.
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
function describeFailure(
  error: unknown,
  backend: MessagesBackend,
  modelId: string,
): string {
  const service = backend.serviceName;
  if (error instanceof Anthropic.AuthenticationError) {
    return withReason(
      `${service} rejected the API key (401). Check ${backend.keyVariable}.`,
      error,
    );
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    // A 403 has many causes (a model the key can't use, a spending limit,
    // a region), so the provider's own reason is the useful part.
    const reason = providerReason(error);
    return reason === undefined
      ? `${service} refused the request (403); the API key may not be allowed to use ${modelId}.`
      : `${service} refused the request (403): ${reason}`;
  }
  if (error instanceof Anthropic.NotFoundError) {
    return withReason(
      `model "${modelId}" was not found or is not available to this API key (404).`,
      error,
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    return withReason(
      `${service} is rate limiting requests (429), even after retries. Try again later.`,
      error,
    );
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return `the request to ${service} timed out.`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return `could not reach ${service}. Check the network connection.`;
  }
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    const known =
      status === undefined ? undefined : backend.statusMessages?.[status];
    if (known !== undefined) return withReason(known, error);
    const statusText = status === undefined ? "" : ` ${status}`;
    const detail = providerReason(error) ?? oneShortLine(error.message);
    return `${service} returned an error${statusText}: ${detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}

const MAX_REASON_LENGTH = 200;

/** A fixed explanation followed by the provider's own reason, when it gave one. */
function withReason(
  message: string,
  error: Error & { error?: unknown },
): string {
  const reason = providerReason(error);
  return reason === undefined
    ? message
    : `${message} The service said: "${reason}"`;
}

/**
 * The service's own explanation from an error response body
 * ({"error": {"message": "..."}}, used by Anthropic and OpenRouter), as one
 * short line, or undefined when the body has none.
 */
function providerReason(
  error: Error & { error?: unknown },
): string | undefined {
  const body = error.error;
  if (
    !isRecord(body) ||
    !isRecord(body.error) ||
    typeof body.error.message !== "string"
  ) {
    return undefined;
  }
  const reason = oneShortLine(body.error.message);
  return reason === "" ? undefined : reason;
}

/**
 * Text as one line of limited length, without the sentences that hold a
 * link: a provider may link to the key's own settings page, which
 * identifies the key.
 */
function oneShortLine(text: string): string {
  const sentences = withoutHiddenCharacters(text)
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/);
  const kept = sentences
    .filter((sentence) => !/https?:\/\/|www\./i.test(sentence))
    .join(" ");
  return kept.length > MAX_REASON_LENGTH
    ? `${kept.slice(0, MAX_REASON_LENGTH - 3)}...`
    : kept;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Removes the API key, and anything else that looks like a secret, from a message. */
function withoutSecrets(message: string, apiKey: string): string {
  return redactSecrets(message.split(apiKey).join("[REDACTED]")).code;
}
