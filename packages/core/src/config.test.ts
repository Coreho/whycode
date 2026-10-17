// Tests for config resolution: defaults, file values, flag overrides, and
// readable errors for bad input.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_FILE_NAME,
  ConfigError,
  loadConfig,
  parseConfigJson,
  resolveConfig,
} from "./config.js";

describe("resolveConfig", () => {
  it("fills in defaults when nothing is configured", () => {
    expect(resolveConfig()).toEqual({
      commentLevel: "light",
      mode: "safe",
      include: ["**/*"],
      exclude: ["node_modules/**", "dist/**"],
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      testCommand: null,
      format: "auto",
      trustFormatterConfig: false,
    });
  });

  it("uses values from the config file", () => {
    const config = resolveConfig({
      commentLevel: "heavy",
      include: ["src/**"],
    });
    expect(config.commentLevel).toBe("heavy");
    expect(config.include).toEqual(["src/**"]);
  });

  it("lets flags override the config file", () => {
    const config = resolveConfig(
      { commentLevel: "heavy", provider: "host" },
      { commentLevel: "medium" },
    );
    expect(config.commentLevel).toBe("medium");
    expect(config.provider).toBe("host");
  });

  it("ignores flags that were not given", () => {
    expect(
      resolveConfig({ commentLevel: "heavy" }, { commentLevel: undefined })
        .commentLevel,
    ).toBe("heavy");
  });

  it("rejects invalid values with a message naming the setting", () => {
    expect(() => resolveConfig({ commentLevel: "extreme" })).toThrow(
      ConfigError,
    );
    expect(() => resolveConfig({ commentLevel: "extreme" })).toThrow(
      /commentLevel/,
    );
  });

  it("rejects unknown keys so typos are caught", () => {
    expect(() => resolveConfig({ commentlevel: "heavy" })).toThrow(
      /commentlevel/,
    );
  });

  it("rejects a config that is not an object", () => {
    expect(() => resolveConfig(["light"])).toThrow(
      /must contain a JSON object/,
    );
  });

  it("gives each result its own default arrays", () => {
    resolveConfig().include.push("mutated/**");
    expect(resolveConfig().include).toEqual(["**/*"]);
  });
});

describe("parseConfigJson", () => {
  it("accepts a UTF-8 byte-order mark", () => {
    const withBom = String.fromCharCode(0xfeff) + '{"mode":"safe"}';
    expect(parseConfigJson(withBom, CONFIG_FILE_NAME)).toEqual({
      mode: "safe",
    });
  });

  it("explains that comments are not allowed", () => {
    expect(() =>
      parseConfigJson('{ "mode": "safe" // why\n}', CONFIG_FILE_NAME),
    ).toThrow(/comments and trailing commas are not allowed/);
  });
});

describe("loadConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "whycode-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns defaults when there is no config file", async () => {
    expect((await loadConfig(dir)).commentLevel).toBe("light");
  });

  it("reads the config file and applies flag overrides on top", async () => {
    const fileConfig = { commentLevel: "heavy", model: "claude-haiku-5-5" };
    await writeFile(join(dir, CONFIG_FILE_NAME), JSON.stringify(fileConfig));
    const config = await loadConfig(dir, { commentLevel: "medium" });
    expect(config.commentLevel).toBe("medium");
    expect(config.model).toBe("claude-haiku-5-5");
  });

  it("throws ConfigError for malformed JSON", async () => {
    await writeFile(join(dir, CONFIG_FILE_NAME), "{ nope");
    await expect(loadConfig(dir)).rejects.toThrow(ConfigError);
  });
});
