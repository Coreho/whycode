// Creates the AI provider named in config, so front-ends need one call.
// The "host" provider (the AI inside Claude Code or VS Code) can only be
// built by those front-ends, so they pass it in.
import type { WhycodeConfig } from "../config.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenRouterProvider } from "./openrouter.js";
import type { AIProvider } from "./provider.js";

export interface ConfiguredProviderOptions {
  /** Where API keys are read from. Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The front-end's own AI, used when config says "host". */
  host?: AIProvider;
}

export function createConfiguredProvider(
  config: Pick<WhycodeConfig, "provider" | "model">,
  options: ConfiguredProviderOptions = {},
): AIProvider {
  switch (config.provider) {
    case "anthropic":
      return createAnthropicProvider({ model: config.model, env: options.env });
    case "openrouter":
      return createOpenRouterProvider({
        model: config.model,
        env: options.env,
      });
    case "host":
      if (options.host === undefined) {
        throw new Error(
          'The "host" provider only works inside Claude Code or VS Code. Choose "anthropic" or "openrouter" instead.',
        );
      }
      return options.host;
  }
}
