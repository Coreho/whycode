// Tests for choosing the AI: a VS Code language model first (Claude
// preferred), then an API key from the environment VS Code started with.
import { resolveConfig } from "@whycode/core";
import { beforeEach, describe, expect, it } from "vitest";
import { chooseAI, pickChatModel } from "./ai.js";
import { fake, fakeChatModel } from "./testing/fake-vscode.js";

const anthropicKey = "sk-ant-" + "a".repeat(40);
const config = resolveConfig();
const model = (id: string, name = id) => ({ id, family: id, name });

beforeEach(() => fake.reset());

describe("pickChatModel", () => {
  it("prefers the model named in config, however its name is punctuated", () => {
    const models = [
      model("gpt-4o"),
      model("claude-haiku-4.5"),
      model("claude-sonnet-5.5"),
    ];
    expect(pickChatModel(models, "claude-sonnet-5-5")?.id).toBe(
      "claude-sonnet-5.5",
    );
  });

  it("then prefers any Claude model, then takes the first", () => {
    const claude = model("copilot-model-2", "Claude Haiku 4.5");
    expect(pickChatModel([model("gpt-4o"), claude], "claude-opus-5-5")).toBe(
      claude,
    );
    expect(
      pickChatModel([model("gpt-4o"), model("gpt-5")], "claude-opus-5-5")?.id,
    ).toBe("gpt-4o");
    expect(pickChatModel([], "claude-opus-5-5")).toBeUndefined();
  });
});

describe("chooseAI", () => {
  const choose = (
    setting: Parameters<typeof chooseAI>[0],
    env: Record<string, string> = {},
    runConfig = config,
  ) => chooseAI(setting, runConfig, env, fake.cancellation);

  it("uses a VS Code language model, sending one folded prompt", async () => {
    const claude = fakeChatModel(
      { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
      () => '{"insertions":[]}',
    );
    fake.models = [claude];

    const ai = await choose("auto", { ANTHROPIC_API_KEY: anthropicKey });

    expect(ai.description).toBe("Claude Sonnet 5.5 (VS Code language model)");
    await expect(
      ai.provider.complete({ system: "Rules.", user: "Code." }),
    ).resolves.toBe('{"insertions":[]}');
    expect(claude.prompts).toEqual(["Rules.\n\nCode."]);
  });

  it("falls back to the API key provider from .whycoderc.json", async () => {
    const anthropic = await choose("auto", { ANTHROPIC_API_KEY: anthropicKey });
    expect(anthropic.provider.name).toBe("anthropic");
    expect(anthropic.description).toBe("claude-sonnet-5-5 (anthropic API)");

    const openRouter = await choose(
      "auto",
      { OPENROUTER_API_KEY: "sk-or-v1-" + "b".repeat(40) },
      resolveConfig({ provider: "openrouter" }),
    );
    expect(openRouter.provider.name).toBe("openrouter");
  });

  it("uses the API key when the setting asks for it, even with a model available", async () => {
    fake.models = [fakeChatModel({ id: "claude-sonnet-5.5" }, () => "")];
    const ai = await choose("anthropic", { ANTHROPIC_API_KEY: anthropicKey });
    expect(ai.provider.name).toBe("anthropic");
  });

  it("never falls back to a key when a language model is required", async () => {
    const env = { ANTHROPIC_API_KEY: anthropicKey };
    await expect(choose("vscode", env)).rejects.toThrow(
      /No VS Code language model is available/,
    );
    await expect(
      choose("auto", env, resolveConfig({ provider: "host" })),
    ).rejects.toThrow(/No VS Code language model is available/);
  });

  it("explains both ways to get a model when neither is set up", async () => {
    await expect(choose("auto")).rejects.toThrow(
      /GitHub Copilot to use one\. ANTHROPIC_API_KEY is not set/,
    );
  });
});
