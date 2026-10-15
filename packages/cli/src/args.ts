// Parses the command line with Node's built-in parser and checks flag values
// up front, so a typo fails before any file is read or any AI is called.
import { parseArgs } from "node:util";
import type { CommentLevel, ConfigOverrides } from "@whycode/core";

export type ParsedArgs =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "check"; paths: string[]; overrides: ConfigOverrides }
  | { kind: "fix"; paths: string[]; overrides: ConfigOverrides; yes: boolean }
  | { kind: "error"; message: string };

const OPTIONS = {
  "comment-level": { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  refactor: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

type FlagValues = ReturnType<typeof parseFlags>["values"];

const COMMANDS = ["check", "fix"] as const;
const COMMENT_LEVELS: readonly CommentLevel[] = ["light", "medium", "heavy"];
const CLI_PROVIDERS = ["anthropic", "openrouter"] as const;

export function parseCommandLine(argv: readonly string[]): ParsedArgs {
  let parsed: ReturnType<typeof parseFlags>;
  try {
    parsed = parseFlags(argv);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: "help" };
  if (values.version === true) return { kind: "version" };

  const [name, ...paths] = positionals;
  if (name === undefined) return usageError("Missing a command.");
  const command = COMMANDS.find((known) => known === name);
  if (command === undefined) return usageError(`Unknown command "${name}".`);
  if (paths.length === 0) {
    return usageError(
      `"whycode ${command}" needs at least one file or directory, e.g. "whycode ${command} src" (or "." for the whole project).`,
    );
  }
  const overrides = parseOverrides(values);
  if (typeof overrides === "string") return usageError(overrides);

  const yes = values.yes === true;
  const refactor = values.refactor === true;
  if (command === "check") {
    if (yes || refactor) {
      return usageError(
        `${yes ? "--yes" : "--refactor"} only applies to "whycode fix".`,
      );
    }
    return { kind: "check", paths, overrides };
  }
  if (yes && refactor) {
    return usageError(
      "--yes can't be combined with --refactor: every rewritten file needs your review.",
    );
  }
  if (refactor) overrides.mode = "refactor";
  return { kind: "fix", paths, overrides, yes };
}

function parseFlags(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });
}

/** Config overrides from flags, or a message describing the bad value. */
function parseOverrides(values: FlagValues): ConfigOverrides | string {
  const overrides: ConfigOverrides = {};
  const level = values["comment-level"];
  if (level !== undefined) {
    const commentLevel = COMMENT_LEVELS.find((known) => known === level);
    if (commentLevel === undefined) {
      return `--comment-level must be light, medium or heavy, not "${level}".`;
    }
    overrides.commentLevel = commentLevel;
  }
  const provider = values.provider;
  if (provider !== undefined) {
    if (provider === "host") {
      return `--provider host only works inside Claude Code or VS Code. Use anthropic or openrouter.`;
    }
    const known = CLI_PROVIDERS.find((name) => name === provider);
    if (known === undefined) {
      return `--provider must be anthropic or openrouter, not "${provider}".`;
    }
    overrides.provider = known;
  }
  if (values.model !== undefined) {
    if (values.model.trim() === "") return "--model needs a model name.";
    overrides.model = values.model;
  }
  return overrides;
}

function usageError(message: string): ParsedArgs {
  return {
    kind: "error",
    message: `${message} Run "whycode --help" for usage.`,
  };
}
