// OpenRouter provider: Claude through OpenRouter's Anthropic-compatible
// Messages endpoint, for people who have an OpenRouter key rather than an
// Anthropic one. Code sent this way passes through OpenRouter as well as the
// model vendor.
import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider } from "./provider.js";
import type {
  MessagesBackend,
  MessagesProviderOptions,
} from "./messages-api.js";
import { createMessagesProvider } from "./messages-api.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

export const openRouterBackend: MessagesBackend = {
  name: "openrouter",
  serviceName: "OpenRouter",
  keyVariable: "OPENROUTER_API_KEY",
  keyDescription: "an OpenRouter API key",
  createClient: createOpenRouterClient,
  modelId: openRouterModelId,
  // OpenRouter's `fallbacks` parameter is its own model routing, not
  // Anthropic's server-side refusal fallback, so it is never sent.
  usesServerSideFallback: () => false,
  statusMessages: {
    402: "the OpenRouter account is out of credits (402). Add credits at https://openrouter.ai/settings/credits.",
  },
};

/**
 * An SDK client pointed at OpenRouter. The key goes in as a bearer token,
 * and apiKey: null stops the SDK from reading ANTHROPIC_API_KEY, so an
 * Anthropic key is never sent to OpenRouter.
 */
export function createOpenRouterClient(apiKey: string): Anthropic {
  return new Anthropic({
    baseURL: OPENROUTER_BASE_URL,
    authToken: apiKey,
    apiKey: null,
  });
}

/**
 * Maps an Anthropic model ID to OpenRouter's slug, e.g. "claude-sonnet-5-5"
 * to "anthropic/claude-sonnet-5.5". A model already written as
 * "vendor/name" is passed through, so any OpenRouter model can be configured.
 */
export function openRouterModelId(model: string): string {
  if (model.includes("/")) return model;
  const versioned = /^(claude-[a-z]+)-(\d+)-(\d+)$/.exec(model);
  if (versioned !== null) {
    const [, family = "", major = "", minor = ""] = versioned;
    return `anthropic/${family}-${major}.${minor}`;
  }
  return model.startsWith("claude-") ? `anthropic/${model}` : model;
}

export type OpenRouterProviderOptions = MessagesProviderOptions;

export function createOpenRouterProvider(
  options: OpenRouterProviderOptions,
): AIProvider {
  return createMessagesProvider(openRouterBackend, options);
}
