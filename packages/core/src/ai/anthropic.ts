// Claude API provider: the direct path to Anthropic, keyed by
// ANTHROPIC_API_KEY. The request and error handling it shares with other
// Messages-API services lives in messages-api.ts.
import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider } from "./provider.js";
import type {
  MessagesBackend,
  MessagesProviderOptions,
} from "./messages-api.js";
import { createMessagesProvider } from "./messages-api.js";

// Models that accept server-side refusal fallback ("default" routing). Other
// models, such as Haiku 5.5, get no fallback.
const SERVER_SIDE_FALLBACK_MODELS: ReadonlySet<string> = new Set([
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);

export const anthropicBackend: MessagesBackend = {
  name: "anthropic",
  serviceName: "the Anthropic API",
  keyVariable: "ANTHROPIC_API_KEY",
  keyDescription: "an Anthropic API key",
  // authToken: null stops the SDK from also sending ANTHROPIC_AUTH_TOKEN,
  // which would make the API reject the request.
  createClient: (apiKey) => new Anthropic({ apiKey, authToken: null }),
  modelId: (model) => model,
  usesServerSideFallback: (modelId) => SERVER_SIDE_FALLBACK_MODELS.has(modelId),
};

export type AnthropicProviderOptions = MessagesProviderOptions;

export function createAnthropicProvider(
  options: AnthropicProviderOptions,
): AIProvider {
  return createMessagesProvider(anthropicBackend, options);
}
