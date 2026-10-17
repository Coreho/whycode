// Parses the command line with Node's built-in parser and checks flag values
// up front, so a typo fails before any file is read or any AI is called.
import { parseArgs } from "node:util";
import type { ChangeScope, CommentLevel, ConfigOverrides } from "@whycode/core";

export type ParsedArgs =
  | { kind: "help" }
  | { kind: "version" }
  | {
      kind: "check";
      paths: string[];
      overrides: ConfigOverrides;
      scope?: ChangeScope;
      savePlan?: string;
      reviewState?: string;
      refresh?: boolean;
      /** Print one JSON report on stdout instead of the usual text. */
      json?: boolean;
    }
  | {
      kind: "fix";
      paths: string[];
      overrides: ConfigOverrides;
      yes: boolean;
      scope?: ChangeScope;
      plan?: string;
      reviewState?: string;
      refresh?: boolean;
      json?: boolean;
    }
  | {
      kind: "prompt";
      paths: string[];
      overrides: ConfigOverrides;
      list: boolean;
    }
  | { kind: "preview"; path: string; plan: string; overrides: ConfigOverrides }
  | {
      kind: "write";
      path: string;
      plan: string;
      overrides: ConfigOverrides;
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
  "save-plan": { type: "string" },
  "review-state": { type: "string" },
  refresh: { type: "boolean" },
  fingerprint: { type: "string" },
  "accept-suggestions": { type: "string" },
  list: { type: "boolean" },
  staged: { type: "boolean" },
  format: { type: "boolean" },
  "no-format": { type: "boolean" },
  diff: { type: "string" },
  json: { type: "boolean" },
  "trust-formatter-config": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

type Flag = keyof typeof OPTIONS;
type FlagValues = ReturnType<typeof parseFlags>["values"];

/** The flags each command accepts, besides --help and --version. */
const COMMAND_FLAGS = {
  check: [
    "review-state",
    "refresh",
    "save-plan",
    "comment-level",
    "provider",
    "model",
    "staged",
    "diff",
    "format",
    "no-format",
    "json",
    "trust-formatter-config",
  ],
  fix: [
    "review-state",
    "refresh",
    "plan",
    "comment-level",
    "provider",
    "model",
    "yes",
    "refactor",
    "staged",
    "diff",
    "format",
    "no-format",
    "json",
    "trust-formatter-config",
  ],
  prompt: [
    "comment-level",
    "list",
    "format",
    "no-format",
    "trust-formatter-config",
  ],
  preview: ["plan", "format", "no-format", "trust-formatter-config"],
  write: [
    "plan",
    "fingerprint",
    "accept-suggestions",
    "format",
    "no-format",
    "trust-formatter-config",
  ],
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
  const scope = parseScope(values);
  if (typeof scope === "string") return usageError(scope);
  // With --staged or --diff, the paths only narrow the changed files.
  if (paths.length === 0 && scope !== undefined) paths.push(".");
  if (paths.length === 0 && !(command === "fix" && values.plan !== undefined)) {
    return usageError(
      `"whycode ${command}" needs at least one file or directory, e.g. "whycode ${command} src" (or "." for the whole project).`,
    );
  }
  if (command === "preview" || command === "write") {
    return parseAgentStep(command, paths, values);
  }
  const overrides = parseOverrides(values);
  if (typeof overrides === "string") return usageError(overrides);
  const persistence = {
    ...(values["review-state"] === undefined
      ? {}
      : { reviewState: values["review-state"] }),
    ...(values.refresh === undefined ? {} : { refresh: values.refresh }),
  };
  if (values.refresh && values["review-state"] === undefined)
    return usageError("--refresh requires --review-state <file>.");
  if (values["review-state"] !== undefined && values.refactor)
    return usageError("Review state only supports safe mode.");
  if (values["review-state"] !== undefined && values["save-plan"] !== undefined)
    return usageError(
      "Use --save-plan for a fresh review, or --review-state to reuse completed reviews; these check options cannot be combined.",
    );
  if (values.plan !== undefined && values.refresh)
    return usageError(
      "--refresh cannot regenerate a saved plan; run check --save-plan again.",
    );
  if (command === "check")
    return {
      kind: "check",
      ...persistence,
      paths,
      overrides,
      scope,
      ...(values.json === true ? { json: true } : {}),
      ...(values["save-plan"] === undefined
        ? {}
        : { savePlan: values["save-plan"] }),
    };
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
  if (values.plan !== undefined && values.refactor === true)
    return usageError("Saved plans only support safe mode.");
  // stdout carries the JSON report, so there is no room for the review prompts.
  if (values.json === true && !yes)
    return usageError(
      "--json with fix needs --yes: stdout carries the JSON report, so there's no room for the interactive review.",
    );
  return {
    kind: "fix",
    ...persistence,
    paths,
    overrides,
    yes,
    scope,
    ...(values.json === true ? { json: true } : {}),
    ...(values.plan === undefined ? {} : { plan: values.plan }),
  };
}

/** --staged or --diff <ref>: which changed files to cover, if either is given. */
function parseScope(values: FlagValues): ChangeScope | undefined | string {
  if (values.staged === true && values.diff !== undefined) {
    return "--staged and --diff can't be combined.";
  }
  if (values.staged === true) return { kind: "staged" };
  if (values.diff === undefined) return undefined;
  const ref = values.diff.trim();
  if (ref === "" || ref.startsWith("-")) {
    return "--diff needs a git ref, e.g. --diff origin/main.";
  }
  return { kind: "diff", ref };
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
  // Only the formatting flags can be set here; they must match the prompt's,
  // since formatting changes the line numbers the plan refers to.
  const overrides = parseOverrides(values);
  if (typeof overrides === "string") return usageError(overrides);
  if (command === "preview") return { kind: "preview", path, plan, overrides };

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
  return {
    kind: "write",
    path,
    plan,
    overrides,
    fingerprint,
    acceptSuggestions,
  };
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
  if (values.format === true && values["no-format"] === true) {
    return "--format and --no-format can't be combined.";
  }
  if (values.format === true) overrides.format = "always";
  if (values["no-format"] === true) overrides.format = "never";
  if (values["trust-formatter-config"] === true)
    overrides.trustFormatterConfig = true;
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
