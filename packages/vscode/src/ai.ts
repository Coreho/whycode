// Chooses the AI for a run. A VS Code language model (from GitHub Copilot or
// another chat extension) comes first, Claude preferred; without one, WhyCode
// uses an API key from the environment VS Code was started with. The key is
// only read from that environment and handed to the core's provider, which
// keeps it out of every message.
import type { AIProvider, WhycodeConfig } from "@whycode/core";
import {
  createConfiguredProvider,
  createHostProvider,
  MissingApiKeyError,
} from "@whycode/core";
import * as vscode from "vscode";
import type { ProviderSetting } from "./settings.js";

export type Env = Readonly<Record<string, string | undefined>>;

export interface ChosenAI {
  provider: AIProvider;
  /** Which model answers, for the output, e.g. "Claude Sonnet 4.5 (VS Code language model)". */
  description: string;
}

type ModelInfo = Pick<vscode.LanguageModelChat, "id" | "family" | "name">;

const NO_LANGUAGE_MODEL =
  "No VS Code language model is available. Sign in to a chat extension such as GitHub Copilot";

export async function chooseAI(
  setting: ProviderSetting,
  config: WhycodeConfig,
  env: Env,
  token: vscode.CancellationToken,
): Promise<ChosenAI> {
  if (setting === "anthropic" || setting === "openrouter") {
    return keyedAI({ ...config, provider: setting }, env);
  }
  const model = pickChatModel(await vscode.lm.selectChatModels(), config.model);
  if (model !== undefined) return languageModelAI(model, token);
  if (setting === "vscode" || config.provider === "host") {
    throw new Error(
      `${NO_LANGUAGE_MODEL}, or set whycode.provider to "anthropic".`,
    );
  }
  try {
    return keyedAI(config, env);
  } catch (error) {
    if (!(error instanceof MissingApiKeyError)) throw error;
    // Neither way to reach a model works: say how to set up either one.
    throw new Error(`${NO_LANGUAGE_MODEL} to use one. ${error.message}`, {
      cause: error,
    });
  }
}

/** Prefers the model named in config, then any Claude model, then the first one. */
export function pickChatModel<Model extends ModelInfo>(
  models: readonly Model[],
  configuredModel: string,
): Model | undefined {
  const wanted = normalizeModelName(configuredModel);
  return (
    models.find((model) =>
      [model.id, model.family].some(
        (name) => normalizeModelName(name) === wanted,
      ),
    ) ??
    models.find((model) =>
      /claude/i.test(`${model.id} ${model.family} ${model.name}`),
    ) ??
    models[0]
  );
}

/** "claude-sonnet-4.5" and "Claude Sonnet 4 5" name the same model. */
function normalizeModelName(name: string): string {
  return name.toLowerCase().replace(/[\s._]+/g, "-");
}

function languageModelAI(
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): ChosenAI {
  const provider = createHostProvider("vscode-lm", async (prompt) => {
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      {
        justification:
          "WhyCode sends the files you chose so the model can suggest comments.",
      },
      token,
    );
    let text = "";
    for await (const fragment of response.text) text += fragment;
    return text;
  });
  return { provider, description: `${model.name} (VS Code language model)` };
}

function keyedAI(config: WhycodeConfig, env: Env): ChosenAI {
  const provider = createConfiguredProvider(config, { env });
  return { provider, description: `${config.model} (${provider.name} API)` };
}
