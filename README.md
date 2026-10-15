# WhyCode

_Last updated: 2026-10-14_

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
- **Next: Phase 3,** real Python and TypeScript adapters (tree-sitter tokens and
  formatters).

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
   comments; it never returns rewritten code. An invalid reply gets one retry,
   then the file is skipped.
6. **Insert comments** as new lines above their targets, then re-format.
   Existing lines are never edited.
7. **Verify:** the token stream must exactly match step 4. If it doesn't, the AI
   changes are thrown away and only the formatting is kept.
8. **Return** the new code (with the original line endings), a unified diff, the
   suggestions for existing comments, and any warnings.

Settings come from `.whycoderc.json` (strict JSON, no comments) at the repo root,
overridden by command-line flags. Unknown keys are rejected so typos are caught.

Refactor mode (`"mode": "refactor"`) is accepted by the config but not
implemented yet. Files are skipped with a clear reason.

### Testing helpers

`@whycode/core/testing` exports `FakeAIProvider` (scripted replies, records
every request) and `createToyAdapter` (a made-up `#`-comment language). Together
they run the real pipeline in tests with no network and no formatters installed.

## Requirements

- Node.js 22.12 or newer
- pnpm 12 (`npm install -g pnpm`)

## Development

```sh
pnpm install     # install dependencies
pnpm build       # compile every package to dist/
pnpm test        # run all tests with Vitest
pnpm lint        # ESLint + Prettier check + type check (including tests)
pnpm format      # rewrite files with Prettier
```

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
      ai/                # provider interface, comment-plan schema, prompts
      comments/          # comment insertion
      languages/         # adapter interface and comment-only fallback
      testing/           # fake provider and toy adapter
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
