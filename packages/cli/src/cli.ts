// The `whycode` command: parses the arguments, runs the chosen command and
// turns failures into a message and exit code 2. bin.ts calls it with the
// real process; tests call it with fake I/O and a fake AI provider.
import { readFileSync } from "node:fs";
import { createConfiguredProvider, defaultAdapters } from "@whycode/core";
import { parseCommandLine } from "./args.js";
import { runPreview, runPrompt, runWrite } from "./agent.js";
import { runCheck } from "./check.js";
import { runFix } from "./fix.js";
import type { CliIo } from "./io.js";
import type { CommandDeps } from "./run.js";
import { EXIT_CODES } from "./run.js";

export const defaultDeps: CommandDeps = {
  adapters: defaultAdapters,
  createProvider: (config, io) =>
    createConfiguredProvider(config, { env: io.env }),
  concurrency: 4,
};

export const HELP_TEXT = `whycode: formats AI-written code and adds comments that explain what it does and why.
Program logic is never changed (unless you ask for --refactor).

Usage:
  whycode check <paths...>    Show the diffs and comment suggestions without writing anything.
                              Exits 0 if nothing would change, 1 if something would,
                              and 2 on errors (bad usage, or a file that failed).
  whycode fix <paths...>      Show each file's diff and ask whether to apply it, then offer
                              suggested rewrites of existing comments one at a time.

For AI agents whose own model writes the comments (used by the Claude Code plugin):
  whycode prompt <paths...>   Print the requests WhyCode would send to an AI (system prompt,
                              reply schema, each file's numbered code). Never needs a key.
                              --list prints only which files would be processed.
  whycode preview <file> --plan <file|->
                              Run the file through WhyCode with the agent's JSON reply and
                              print the diff, suggestions and a fingerprint. Writes nothing.
  whycode write <file> --plan <file|-> --fingerprint <fp> [--accept-suggestions 1,3]
                              Write exactly what the preview with that fingerprint showed,
                              plus the accepted suggestions.

Paths can be files or directories. Files ignored by .gitignore and files
that may hold secrets (.env, *.pem, *.key, ...) are never read.

Options:
  --comment-level <level>     light (default), medium or heavy
  --provider <name>           anthropic (default, needs ANTHROPIC_API_KEY) or
                              openrouter (needs OPENROUTER_API_KEY)
  --model <id>                Claude model to use (default: claude-sonnet-5-5)
  --staged                    check/fix: only files staged in git
  --diff <ref>                check/fix: only files changed since the branch left <ref>
                              (committed, uncommitted and new), e.g. --diff origin/main.
                              With either, paths are optional and narrow the changes.
  -y, --yes                   fix: apply every file's changes without asking. Existing
                              comments are still never edited. Not allowed with --refactor.
  --refactor                  fix: let the AI rewrite the code. Logic WILL change; asks
                              for confirmation, and every file needs your review.
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
        return await runCheck(args.paths, args.overrides, io, deps, args.scope);
      case "fix":
        return await runFix(args.paths, args, io, deps);
      case "prompt":
        return await runPrompt(args, io, deps);
      case "preview":
        return await runPreview(args.path, args.plan, io, deps);
      case "write":
        return await runWrite(args, io, deps);
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
