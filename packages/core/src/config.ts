// Loads WhyCode settings: defaults, then .whycoderc.json at the repo root,
// then command-line flags. Only loadConfig touches the filesystem.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";

export const CONFIG_FILE_NAME = ".whycoderc.json";

const commentLevelSchema = z.enum(["light", "medium", "heavy"]);
const modeSchema = z.enum(["safe", "refactor"]);
const providerNameSchema = z.enum(["anthropic", "host"]);

// strictObject rejects unknown keys, so typos like "commentlevel" are reported.
export const configSchema = z.strictObject({
  commentLevel: commentLevelSchema.default("light"),
  mode: modeSchema.default("safe"),
  include: z.array(z.string()).default(() => ["**/*"]),
  exclude: z.array(z.string()).default(() => ["node_modules/**", "dist/**"]),
  provider: providerNameSchema.default("anthropic"),
  model: z.string().min(1).default("claude-sonnet-5-5"),
  testCommand: z.string().min(1).nullable().default(null),
});

export type WhycodeConfig = z.output<typeof configSchema>;
export type CommentLevel = z.output<typeof commentLevelSchema>;
export type Mode = z.output<typeof modeSchema>;
export type ProviderName = z.output<typeof providerNameSchema>;
/** Values from command-line flags; undefined means "flag not given". */
export type ConfigOverrides = Partial<WhycodeConfig>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Merges file settings and flag overrides over the defaults, then validates. */
export function resolveConfig(
  fileConfig: unknown = {},
  overrides: ConfigOverrides = {},
): WhycodeConfig {
  if (!isPlainObject(fileConfig)) {
    throw new ConfigError(`${CONFIG_FILE_NAME} must contain a JSON object.`);
  }
  const result = configSchema.safeParse({
    ...fileConfig,
    ...withoutUndefined(overrides),
  });
  if (!result.success) {
    throw new ConfigError(
      `Invalid WhyCode configuration:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

/** Reads <rootDir>/.whycoderc.json if present and resolves the final config. */
export async function loadConfig(
  rootDir: string,
  overrides: ConfigOverrides = {},
): Promise<WhycodeConfig> {
  const path = join(rootDir, CONFIG_FILE_NAME);
  const text = await readOptionalFile(path);
  const fileConfig = text === undefined ? {} : parseConfigJson(text, path);
  return resolveConfig(fileConfig, overrides);
}

/** Parses config file text. Strict JSON: comments and trailing commas are errors. */
export function parseConfigJson(text: string, path: string): unknown {
  try {
    // Strip a UTF-8 byte-order mark, which some Windows editors add.
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      `${path} is not valid JSON (comments and trailing commas are not allowed): ${detail}`,
    );
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutUndefined(overrides: ConfigOverrides): ConfigOverrides {
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
}
