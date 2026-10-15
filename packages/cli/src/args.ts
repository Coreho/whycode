// Parses the command line with Node's built-in parser and checks flag values
// up front, so a typo fails before any file is read or any AI is called.
import { parseArgs } from "node:util";
import type { CommentLevel, ConfigOverrides } from "@whycode/core";

export type ParsedArgs =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "check"; paths: string[]; overrides: ConfigOverrides }
  | { kind: "fix"; paths: string[]; overrides: ConfigOverrides; yes: boolean }
  | {
      kind: "prompt";
      paths: string[];
      overrides: ConfigOverrides;
      list: boolean;
    }
  | { kind: "preview"; path: string; plan: string }
  | {
      kind: "write";
      path: string;
      plan: string;
      fingerprint: string;
      acceptSuggestions: number[];
    }
  | { kind: "error"; message: string };

const OPTIONS = {
  "comment-level": { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  refactor: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  plan: { type: "string" },
  fingerprint: { type: "string" },
  "accept-suggestions": { type: "string" },
  list: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

type Flag = keyof typeof OPTIONS;
type FlagValues = ReturnType<typeof parseFlags>["values"];

/** The flags each command accepts, besides --help and --version. */
const COMMAND_FLAGS = {
  check: ["comment-level", "provider", "model"],
  fix: ["comment-level", "provider", "model", "yes", "refactor"],
  prompt: ["comment-level", "list"],
  preview: ["plan"],
  write: ["plan", "fingerprint", "accept-suggestions"],
} as const satisfies Record<string, readonly Flag[]>;
type Command = keyof typeof COMMAND_FLAGS;

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
  const command = Object.keys(COMMAND_FLAGS).find((known) => known === name);
  if (command === undefined) return usageError(`Unknown command "${name}".`);
  return parseCommand(command as Command, paths, values);
}

function parseCommand(
  command: Command,
  paths: string[],
  values: FlagValues,
): ParsedArgs {
  const stray = unsupportedFlag(command, values);
  if (stray !== undefined) {
    return usageError(`--${stray} doesn't apply to "whycode ${command}".`);
  }
  if (paths.length === 0) {
    return usageError(
      `"whycode ${command}" needs at least one file or directory, e.g. "whycode ${command} src" (or "." for the whole project).`,
    );
  }
  if (command === "preview" || command === "write") {
    return parseAgentStep(command, paths, values);
  }
  const overrides = parseOverrides(values);
  if (typeof overrides === "string") return usageError(overrides);
  if (command === "check") return { kind: "check", paths, overrides };
  if (command === "prompt") {
    return { kind: "prompt", paths, overrides, list: values.list === true };
  }

  const yes = values.yes === true;
  if (yes && values.refactor === true) {
    return usageError(
      "--yes can't be combined with --refactor: every rewritten file needs your review.",
    );
  }
  if (values.refactor === true) overrides.mode = "refactor";
  return { kind: "fix", paths, overrides, yes };
}

/** `preview` and `write` handle one file and need the external model's plan. */
function parseAgentStep(
  command: "preview" | "write",
  paths: string[],
  values: FlagValues,
): ParsedArgs {
  const [path] = paths;
  if (path === undefined || paths.length > 1) {
    return usageError(`"whycode ${command}" takes exactly one file.`);
  }
  const plan = values.plan;
  if (plan === undefined) {
    return usageError(
      `"whycode ${command}" needs --plan <file> (or - for stdin).`,
    );
  }
  if (command === "preview") return { kind: "preview", path, plan };

  const fingerprint = values.fingerprint;
  if (fingerprint === undefined) {
    return usageError(
      `"whycode write" needs the --fingerprint that "whycode preview" printed.`,
    );
  }
  const acceptSuggestions = parseNumberList(values["accept-suggestions"] ?? "");
  if (acceptSuggestions === undefined) {
    return usageError(
      "--accept-suggestions takes suggestion numbers separated by commas, e.g. 1,3.",
    );
  }
  return { kind: "write", path, plan, fingerprint, acceptSuggestions };
}

function unsupportedFlag(
  command: Command,
  values: FlagValues,
): Flag | undefined {
  const allowed: readonly Flag[] = [
    ...COMMAND_FLAGS[command],
    "help",
    "version",
  ];
  const given = Object.keys(values).filter(
    (flag): flag is Flag => flag in OPTIONS,
  );
  return given.find((flag) => !allowed.includes(flag));
}

/** "1,3" -> [1, 3]; undefined unless every item is a positive whole number. */
function parseNumberList(text: string): number[] | undefined {
  if (text.trim() === "") return [];
  const items = text.split(",").map((item) => item.trim());
  if (!items.every((item) => /^[1-9]\d*$/.test(item))) return undefined;
  return items.map(Number);
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
