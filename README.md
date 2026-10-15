# WhyCode

_Last updated: 2026-10-15_

WhyCode cleans up AI-written code so humans can understand it. It fixes
formatting and adds comments that explain **what** the code does and **why**,
without changing program logic.

It will ship as four front-ends sharing one core engine: a CLI (`whycode`), a
Claude Code plugin, a VS Code extension, and a GitHub Action.

## Status

Early development. Nothing user-facing exists yet. See `CLAUDE.md` for the full
build plan.

- **Phase 1 (scaffold): done.** pnpm monorepo, strict TypeScript, ESLint,
  Prettier, Vitest.
- **Phase 2 (core skeleton): done.** The `@whycode/core` pipeline runs from start
  to finish offline, using a fake AI provider and a toy test language.
- **Phase 3 (Python and TypeScript adapters): done.** Real languages now go
  through the pipeline, with tree-sitter tokens and real formatters.
- **Phase 4 (verification proof): done.** Tests with the real adapters show
  that every way a comment could change the code is caught or refused.
- **Phase 5 (Claude provider and prompts): done.** The core can now get real
  comments from Claude through the API, with tuned prompts per comment level.
- **Next: Phase 6,** the `whycode` CLI with interactive preview (and TASK-11,
  the trailing-comma fix, before the CLI ships).

## Supported languages

| Language   | Extensions                    | Formatter                                                           | Notes                                                                                      |
| ---------- | ----------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Python     | `.py`, `.pyi`                 | [Ruff](https://docs.astral.sh/ruff/) (`ruff format`), found on PATH | Without Ruff, comments are still added and verified; formatting is skipped with a warning. |
| TypeScript | `.ts`, `.mts`, `.cts`         | Prettier (bundled)                                                  |                                                                                            |
| TSX        | `.tsx`                        | Prettier (bundled)                                                  |                                                                                            |
| JavaScript | `.js`, `.mjs`, `.cjs`, `.jsx` | Prettier (bundled)                                                  | JSX is supported in `.js` files.                                                           |

Formatters use the project's own settings: Prettier reads `.prettierrc` and
`.editorconfig`, Ruff reads `pyproject.toml` or `ruff.toml`, both found from the
file's location.

Tokens come from [tree-sitter](https://tree-sitter.github.io/) grammars compiled
to WebAssembly. They ship with the npm grammar packages, so nothing is downloaded
at runtime and nothing needs compiling. pnpm is told not to build the grammars'
native bindings (`allowBuilds` in `pnpm-workspace.yaml`).

Comments are never placed directly after a line ending in a backslash. That
backslash continues the line, so in Python, for example, the comment would break
the code.

## How the core works

`processFile({ path, code }, config, { provider, adapters })` handles one file
and returns a result. It never writes to disk.

1. **Privacy check:** files like `.env*`, `*.pem`, `*.key`, and SSH keys are
   skipped and never sent to an AI.
2. **Detect language** from the file extension:
   - A language with an adapter gets the full pipeline.
   - A known language without an adapter (Ruby, C, SQL, ...) gets comments only,
     with no formatting and no verification, and the result is labeled that way.
   - Anything else is skipped.
3. **Format** with the language's formatter. If none is installed, WhyCode warns
   and carries on.
4. **Record the token stream**, ignoring comments.
5. **Ask the AI for a comment plan.** Likely secrets are masked first. The AI
   returns JSON listing comments to insert and suggestions for existing
   comments; it never returns rewritten code. Providers that support it are
   held to a JSON schema. An invalid reply gets one retry, then the file is
   skipped.
6. **Insert comments** as new lines above their targets, then re-format.
   Existing lines are never edited.
7. **Verify:** the token stream must exactly match step 4. If it doesn't, or if
   the formatter rejects the code once the comments are in, the AI changes are
   thrown away and only the formatting is kept.
8. **Return** the new code (with the original line endings), a unified diff, the
   suggestions for existing comments, and any warnings.

### What verification guarantees

`src/verification.test.ts` runs the real Python and TypeScript adapters over
`fixtures/*/verification.*`, a file per language full of risky constructs:

| Risk                                                                 | What happens                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Comment lands inside a multi-line string or template literal         | Caught: the string's contents changed, so the AI changes are discarded |
| Comment lands in JSX text                                            | Caught the same way                                                    |
| Comment after a backslash line continuation                          | Refused before insertion, with a warning                               |
| Comment text containing newlines, `*/`, or code                      | Neutralized: every line becomes its own comment line                   |
| Comment between JSX attributes or inside a JSX expression            | Kept: it's valid code and the tokens don't change                      |
| A logic change slipping in (operator, identifier, removed statement) | Caught, and the warning names the first differing token                |

Switching off the token comparison makes every "caught" test fail, so the
suite really depends on it.

Known limitation: when Ruff has placed a call's arguments together on one
indented line, a comment above that line makes Ruff split them one per line
and add a trailing comma. That counts as a token change, so those comments are
discarded. Nothing unsafe is written, but the comments are lost.

Settings come from `.whycoderc.json` (strict JSON, no comments) at the repo root,
overridden by command-line flags. Unknown keys are rejected so typos are caught.

Refactor mode (`"mode": "refactor"`) is accepted by the config but not
implemented yet. Files are skipped with a clear reason.

### Using Claude

`createConfiguredProvider(config)` returns the AI provider named by
`"provider"` in config. The model comes from config (`claude-sonnet-5-5` by
default).

| `provider`            | Key (env var only)   | Sends code to                                                       |
| --------------------- | -------------------- | ------------------------------------------------------------------- |
| `anthropic` (default) | `ANTHROPIC_API_KEY`  | Anthropic                                                           |
| `openrouter`          | `OPENROUTER_API_KEY` | OpenRouter, which passes it to Anthropic                            |
| `host`                | none                 | the AI inside Claude Code or VS Code (supplied by those front-ends) |

- **API key:** read only from that provider's variable. If it's missing,
  creating the provider fails at once with a clear message, before any network
  call. The key never appears in warnings, errors, or skip reasons.
- **OpenRouter:** uses OpenRouter's Anthropic-compatible endpoint. Model IDs
  are translated (`claude-sonnet-5-5` becomes `anthropic/claude-sonnet-5.5`),
  and a model written as `vendor/name` is passed through as is. Anthropic's
  refusal fallback isn't used, and running out of OpenRouter credits skips the
  file with a clear reason.
- **Structured output:** Claude's reply is constrained to the comment-plan JSON
  schema, and WhyCode still validates it.
- **Prompts:** a system prompt per comment level (light, medium, heavy) asks for
  comments that explain why rather than restate the code, and warns against the
  placements verification rejects. It is identical for every file in a run, so
  it is cached.
- **Refusals:** with the `anthropic` provider and a model that supports it
  (Sonnet 5.5, Opus 5/5.5, Fable 5/5.1), server-side refusal fallback is on. If Claude declines a file for a
  safety reason, the API retries it on another model. A refusal that still
  stands skips the file with the reason.
- **Failures:** a rejected key, rate limiting, a missing model, or a network
  problem skips that file with a readable reason instead of stopping the run.
  The SDK retries rate limits and network errors twice first.

### Testing helpers

`@whycode/core/testing` exports:

- `FakeAIProvider`: scripted replies, and it records every request.
- `createToyAdapter`: a made-up `#`-comment language.
- `commentAboveFirstMatch` and `commentAboveEveryMatch`: scripted replies that
  aim comments at lines matching a pattern, so tests don't hard-code line
  numbers that move when the formatter runs.

Together they run the real pipeline in tests with no network.

## Requirements

- Node.js 22.12 or newer
- pnpm 12 (`npm install -g pnpm`)
- Optional: [Ruff](https://docs.astral.sh/ruff/) on PATH, to format Python
  (`pip install ruff`, or `winget install astral-sh.ruff` on Windows). Without
  it, Python files still get comments and verification, and one Ruff test is
  skipped.

## Development

```sh
pnpm install     # install dependencies
pnpm build       # compile every package to dist/
pnpm test        # run all tests with Vitest
pnpm lint        # ESLint + Prettier check + type check (including tests)
pnpm format      # rewrite files with Prettier
```

The tests never call an AI service, except two live smoke tests (one per
provider) that run only when you opt in with `WHYCODE_LIVE_TESTS=1` and the
provider's key. Each makes a real, billed request:

```sh
ANTHROPIC_API_KEY=sk-ant-... WHYCODE_LIVE_TESTS=1 pnpm test
OPENROUTER_API_KEY=sk-or-... WHYCODE_LIVE_TESTS=1 pnpm test
```

### Task tracking

Tasks are tracked with [Backlog.md](https://github.com/MrLesk/Backlog.md) as
Markdown files in `backlog/` (install the CLI with `npm install -g backlog.md`).

```sh
backlog board            # Kanban board in the terminal
backlog browser          # web UI on http://localhost:6420
backlog task create "Title" -d "Description"
backlog task list --plain
```

Use the `backlog` CLI rather than editing task files by hand. `CLAUDE.md` and
`AGENTS.md` tell AI agents to do the same. Prettier skips `backlog/` and
`AGENTS.md` because the CLI writes them.

## Repository layout

```
packages/
  core/                  # the engine: all real logic, no UI
    src/
      pipeline.ts        # per-file pipeline (steps above)
      config.ts          # .whycoderc.json + flag overrides
      diff.ts            # unified diffs for previews
      verify.ts          # token-stream comparison
      privacy.ts         # sensitive-file check and secret masking
      text.ts            # line-ending helpers
      process.ts         # runs external formatters (ruff) with code on stdin
      ai/                # providers (Anthropic, OpenRouter), schema, prompts
      comments/          # comment insertion
      languages/         # adapters (python.ts, typescript.ts), shared
                         # tree-sitter tokens, comment-only fallback
      testing/           # fake provider and toy adapter
    fixtures/            # messy AI-style sample code per language
```

The CLI, Claude Code plugin, VS Code extension, and GitHub Action packages are
added in later phases.

## Toolchain notes

- **TypeScript is pinned to 6.0.x.** TypeScript 7 is out, but
  `typescript-eslint` only supports TypeScript below 6.1 so far. Move to 7 once
  `typescript-eslint` adds support.
- **Line endings are LF** everywhere (`.gitattributes`), so the Prettier check
  passes on Windows checkouts too.

## License

MIT
