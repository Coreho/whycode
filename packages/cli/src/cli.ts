// The `whycode` command: parses the arguments, runs the chosen command and
// turns failures into a message and exit code 2. bin.ts calls it with the
// real process; tests call it with fake I/O and a fake AI provider.
import { readFileSync } from "node:fs";
import { createConfiguredProvider, defaultAdapters } from "@whycode/core";
import { parseCommandLine } from "./args.js";
import type { CommandDeps } from "./check.js";
import { EXIT_CODES, runCheck } from "./check.js";
import type { CliIo } from "./io.js";

export const defaultDeps: CommandDeps = {
  adapters: defaultAdapters,
  createProvider: (config, io) =>
    createConfiguredProvider(config, { env: io.env }),
  concurrency: 4,
};

export const HELP_TEXT = `whycode: formats AI-written code and adds comments that explain what it does and why.
Program logic is never changed.

Usage:
  whycode check <paths...>    Show the diffs and comment suggestions without writing anything.
                              Exits 0 if nothing would change, 1 if something would,
                              and 2 on errors (bad usage, or a file that failed).

Paths can be files or directories. Files ignored by .gitignore and files
that may hold secrets (.env, *.pem, *.key, ...) are never read.

Options:
  --comment-level <level>     light (default), medium or heavy
  --provider <name>           anthropic (default, needs ANTHROPIC_API_KEY) or
                              openrouter (needs OPENROUTER_API_KEY)
  --model <id>                Claude model to use (default: claude-sonnet-5-5)
  -h, --help                  Show this help
  -v, --version               Show the version

Settings can also be kept in .whycoderc.json at the project root; flags win.
`;

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  deps: CommandDeps = defaultDeps,
): Promise<number> {
  const args = parseCommandLine(argv);
  try {
    switch (args.kind) {
      case "help":
        io.stdout(HELP_TEXT);
        return EXIT_CODES.clean;
      case "version":
        io.stdout(`${cliVersion()}\n`);
        return EXIT_CODES.clean;
      case "error":
        io.stderr(`whycode: ${args.message}\n`);
        return EXIT_CODES.error;
      case "check":
        return await runCheck(args.paths, args.overrides, io, deps);
    }
  } catch (error) {
    // Config errors, a missing API key and the like: the message says what to fix.
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`whycode: ${message}\n`);
    return EXIT_CODES.error;
  }
}

/** The version in this package's package.json, one folder above src/ and dist/. */
function cliVersion(): string {
  const packageJson: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const version =
    typeof packageJson === "object" &&
    packageJson !== null &&
    "version" in packageJson
      ? packageJson.version
      : undefined;
  return typeof version === "string" ? version : "unknown";
}
