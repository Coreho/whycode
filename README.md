# WhyCode

_Last updated: 2026-10-14_

WhyCode cleans up AI-written code so humans can understand it. It fixes
formatting and adds comments that explain **what** the code does and **why**,
without changing program logic.

It will ship as four front-ends sharing one core engine: a CLI (`whycode`), a
Claude Code plugin, a VS Code extension, and a GitHub Action.

## Status

Early development. **Phase 1 (scaffold) is done:** the pnpm monorepo, strict
TypeScript, ESLint, Prettier, and Vitest are set up, with an empty
`@whycode/core` package. Nothing user-facing exists yet. See `CLAUDE.md` for the
full build plan.

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
  core/          # the engine: all real logic, no UI
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
