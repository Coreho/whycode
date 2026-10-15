// Tests for picking the AI provider named in config.
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import { FakeAIProvider } from "../testing/fake-provider.js";
import { MissingApiKeyError } from "./messages-api.js";
import { createConfiguredProvider } from "./providers.js";

const env = {
  ANTHROPIC_API_KEY: "sk-ant-" + "a".repeat(40),
  OPENROUTER_API_KEY: "sk-or-v1-" + "b".repeat(40),
};

describe("createConfiguredProvider", () => {
  it.each(["anthropic", "openrouter"] as const)(
    "creates the %s provider",
    (provider) => {
      const config = resolveConfig({ provider });
      expect(createConfiguredProvider(config, { env }).name).toBe(provider);
    },
  );

  it("uses the front-end's own AI for the host provider", () => {
    const host = new FakeAIProvider("{}");
    expect(
      createConfiguredProvider(resolveConfig({ provider: "host" }), { host }),
    ).toBe(host);
  });

  it("explains that the host provider needs Claude Code or VS Code", () => {
    expect(() =>
      createConfiguredProvider(resolveConfig({ provider: "host" })),
    ).toThrow(/only works inside Claude Code or VS Code/);
  });

  it("reports the missing key for the chosen provider", () => {
    const config = resolveConfig({ provider: "openrouter" });
    expect(() => createConfiguredProvider(config, { env: {} })).toThrow(
      MissingApiKeyError,
    );
    expect(() => createConfiguredProvider(config, { env: {} })).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });
});
