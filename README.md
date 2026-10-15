# WhyCode

_Last updated: 2026-10-15_

WhyCode cleans up AI-written code so humans can understand it. It fixes
formatting and adds comments that explain **what** the code does and **why**,
without changing program logic.

It comes as four front-ends that share one core engine: a CLI (`whycode`), a
Claude Code plugin, a VS Code extension and a GitHub Action.

## Status

All eleven build phases in [`CLAUDE.md`](CLAUDE.md) are implemented and
tested, but nothing is published yet:

| Front-end          | State                                                             |
| ------------------ | ----------------------------------------------------------------- |
| CLI                | Packed and install-tested as the npm package `whycode`            |
| Claude Code plugin | Validated, and run end to end in Claude Code from a checkout      |
| VS Code extension  | Packaged as a `.vsix`; the Marketplace publisher is a placeholder |
| GitHub Action      | Bundled and tested offline; needs a release with its `dist/`      |

Tasks are tracked in [`backlog/`](#task-tracking).

## What WhyCode promises

- **Logic never changes in the default (safe) mode.** WhyCode records the
  code's tokens before adding comments and compares them afterwards. If
  anything but comments changed, the comments are thrown away and only the
  formatting is kept.
- **Existing comments are never edited automatically.** Improvements to them
  are offered as separate suggestions, each accepted on its own, and a
  suggestion can only change comment text.
- **Nothing is written without a preview.** Every front-end shows the diff
  first: an interactive prompt in the CLI, the diff view in VS Code, a diff in
  Claude Code, and review suggestions on the pull request.
- **Refactor mode is opt-in.** Only `whycode fix --refactor` lets the AI rewrite
  code, with a warning, a confirmation and a review of every file.
- **Private files stay private.** Files git ignores and files that may hold
  secrets are never read, and likely secrets in the code that is sent are
  masked. [PRIVACY.md](PRIVACY.md) has the details.

## Front-ends

### CLI

```sh
npm install -g whycode          # once published; needs Node.js 22.12 or newer
export ANTHROPIC_API_KEY=sk-ant-...

whycode check src               # dry run: diffs and suggestions, writes nothing
whycode fix src                 # review each file's diff, write what you accept
whycode fix . --yes             # accept every file's changes without asking
whycode fix app.py --refactor   # let the AI rewrite the code (logic will change)
```

Until it is published, run `node packages/cli/dist/bin.js` from a checkout
after `pnpm build`. The package's [README](packages/cli/README.md) doubles as
its npm page.

- **`check <paths...>`** prints a unified diff for each file that would change,
  suggested rewrites of existing comments, notes (such as a missing formatter),
  the paths it skipped and why, and a summary. It never writes. Up to four
  files are sent to the AI at once, and results print in path order.
- **`fix <paths...>`** shows each diff and asks `[y]es / [n]o / [s]kip /
[q]uit`, then offers suggested rewrites of existing comments one at a time.
  Only accepted files are written, with their original line endings, and a
  file edited during the review is never overwritten. A summary lists the files
  written, rejected, skipped, not reviewed, and those where verification failed
  (so only formatting was offered).
  - `--yes` accepts every file's changes without asking, but never applies
    suggestions for existing comments: those always need a person.
  - Without a terminal (in CI, or with piped input) and without `--yes`, `fix`
    writes nothing and says why.
  - `--refactor` warns, asks for confirmation, shows the AI's list of changes
    and your `testCommand` result with each diff, and can't be combined with
    `--yes`.

| Flag                      | Effect                                    |
| ------------------------- | ----------------------------------------- |
| `--comment-level <level>` | `light` (default), `medium` or `heavy`    |
| `--provider <name>`       | `anthropic` (default) or `openrouter`     |
| `--model <id>`            | Claude model, default `claude-sonnet-5-5` |
| `-y`, `--yes`             | `fix` only: accept every file's changes   |
| `--refactor`              | `fix` only: let the AI rewrite the code   |
| `-h`, `--help`            | Usage                                     |
| `-v`, `--version`         | Version                                   |

**Verdicts.** Every processed file gets a one-line verdict, worded the same in
every front-end:

| Verdict                                                               | Meaning                                                        |
| --------------------------------------------------------------------- | -------------------------------------------------------------- |
| nothing to change                                                     | The file is fine as it is                                      |
| N comments added; comment insertion preserved the checked code tokens | Comments (and any formatting) passed verification              |
| formatting only (no comments were needed)                             | Only the formatter changed the file                            |
| comments discarded because verification failed                        | The AI's comments were thrown away; at most formatting remains |
| N comments added without verification                                 | A comments-only language, which WhyCode can't verify           |
| rewritten by the AI, so logic may change                              | Refactor mode                                                  |
| not processed: _reason_                                               | The file failed, for example because the AI call did           |

Suggested rewrites of existing comments are counted after the verdict, and
notes (such as discarded comments or a missing formatter) are always shown,
even when there is no diff.

**Exit codes:** `check` exits 0 when every file is clean, and 1 when a file
would change or had its comments discarded, so CI can use it as a gate.
`fix` exits 0 when it finishes, whatever you chose. Both exit 2 on errors: bad
usage, an invalid config, a missing API key, a path that doesn't exist, or a
file that couldn't be processed or written.

### Claude Code plugin

```
/plugin marketplace add Coreho/whycode
/plugin install whycode@whycode
/whycode:cleanup src --comment-level medium
```

The plugin ([README](packages/claude-code-plugin/README.md)) uses Claude
Code's own model, so no API key is needed; the `whycode` CLI must be on your
PATH. For each file, Claude shows the diff WhyCode produced and asks whether to
apply it, then asks about each suggested rewrite of an existing comment.

Claude Code's model can't be called through an API, so the CLI has three
commands that let any agent act as WhyCode's AI:

- `whycode prompt <paths...>` prints exactly what WhyCode would send to a
  model: the system prompt, the reply schema and each file's numbered code
  (`--list` prints only which files would be processed). File collection and
  secret masking work as usual, and no provider is ever created.
- `whycode preview <file> --plan <file|->` runs the file through the normal
  pipeline with the agent's JSON reply as the AI's answer: the same
  validation, insertion, formatting and logic-unchanged check. It prints the
  diff, the numbered suggestions and a fingerprint, and writes nothing.
- `whycode write <file> --plan <file|-> --fingerprint <fp>
[--accept-suggestions 1,3]` recomputes the result and writes it only if the
  fingerprint matches, so what is written is exactly what the person saw. The
  fingerprint covers the file, the new code, the verification outcome, the
  notes and every suggested comment rewrite in order, so a plan whose
  suggestions changed after the preview is refused, and an accepted number
  always means the suggestion that was shown.

The pipeline is deterministic up to the AI call, which is what makes this
work: the core's `captureCommentRequest` stops at the AI call and returns the
request, and `processWithReply` runs the file again with the reply. The skill
pre-approves only `whycode --version`, `whycode prompt` and `whycode preview`,
so Claude Code asks your permission before every `whycode write`.

### VS Code extension

```sh
pnpm build
pnpm --filter whycode-vscode run package     # builds dist/whycode-vscode.vsix
code --install-extension packages/vscode/dist/whycode-vscode.vsix
```

The extension ([README](packages/vscode/README.md)) needs VS Code 1.95 or
newer.

- **Commands:** _WhyCode: Clean Up Current File_ (Command Palette and editor
  context menu) and _Clean Up with WhyCode_ (Explorer context menu, for several
  selected files and folders), with a cancellable progress notification.
- **Review:** each proposal opens in the diff view next to the file, and a
  quick pick asks to Apply, Discard or Stop. Files with unsaved edits, or edited
  during the review, are never overwritten. Suggested rewrites of existing
  comments come in a multi-select list where nothing is ticked.
- **AI:** with `whycode.provider` set to `auto`, a VS Code language model is
  used when one is available (preferring Claude); otherwise the API key
  provider, with the key from the environment VS Code started with. Keys are
  never stored.
- **Settings:** `whycode.commentLevel` and `whycode.provider`. Safe mode only;
  untrusted workspaces aren't supported, because formatter config can run code.

### GitHub Action

The action ([README](packages/github-action/README.md)) runs on pull requests,
processes only the files the PR changed, and posts one review whose
`suggestion` blocks authors can apply one by one. It never pushes commits.

```yaml
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  whycode:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          ref: ${{ github.event.pull_request.head.sha }}
      - uses: YOUR_ORG/whycode@ACTION_RELEASE_SHA # a release that includes dist/
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          comment-level: light
```

The action's README has the full workflow, including skipping fork pull
requests, which can't read repository secrets. GitHub only accepts suggestions
on lines inside the PR's diff, so changes
elsewhere (often formatting) are counted in the review summary instead. Files
that fail verification or processing are listed there too, and get no
suggestions. The key is masked in the logs.

## Configuration

Put a `.whycoderc.json` at the repository root. It is strict JSON (no
comments), unknown keys are rejected so typos are caught, and command-line
flags or editor settings override it.

```json
{
  "commentLevel": "light",
  "mode": "safe",
  "include": ["src/**"],
  "exclude": ["**/*.test.*", "dist/**"],
  "provider": "anthropic",
  "model": "claude-sonnet-5-5",
  "testCommand": null
}
```

| Key            | Default                          | Meaning                                                                                   |
| -------------- | -------------------------------- | ----------------------------------------------------------------------------------------- |
| `commentLevel` | `"light"`                        | How much to comment; see [Comment levels](#comment-levels)                                |
| `mode`         | `"safe"`                         | `"safe"` or `"refactor"`; see [Safe mode and refactor mode](#safe-mode-and-refactor-mode) |
| `include`      | `["**/*"]`                       | Globs (relative to the root) a file must match to be processed                            |
| `exclude`      | `["node_modules/**", "dist/**"]` | Globs that leave files out; folders a `/**` glob covers aren't even walked                |
| `provider`     | `"anthropic"`                    | `"anthropic"` (`ANTHROPIC_API_KEY`) or `"openrouter"` (`OPENROUTER_API_KEY`)              |
| `model`        | `"claude-sonnet-5-5"`            | Claude model ID                                                                           |
| `testCommand`  | `null`                           | Shell command run against each rewritten file in `fix --refactor`                         |

Keys come only from environment variables; there is no setting for one. The
plugin, the extension and the action always run safe mode, and the action
never runs `testCommand`.

**Which files are read.** The project root is the git repository's top folder,
or else the nearest folder with a `.whycoderc.json`. Within it:

- Files and folders git ignores are never read: your global excludes file
  (`core.excludesFile`, or `~/.config/git/ignore`), the repository's
  `info/exclude` (also in worktrees), and every `.gitignore` from the root down,
  deeper ones winning. A file inside an ignored folder stays ignored, as in
  git. `.git` itself is never entered.
- Files that may hold secrets (`.env*`, `*.pem`, `*.key`, SSH keys, `.npmrc`,
  ...) are never read, even when named directly.
- Folders contribute only files in languages WhyCode handles, so a README isn't
  reported as skipped. A file you name directly is always reported.
- Files over 1 MB, symbolic links (and paths through a linked folder), binary
  files and files that aren't UTF-8 are skipped.

File collection lives in the core (`collectFiles`), so every front-end applies
the same rules, and skipped paths are always listed with the reason.

## Comment levels

| Level             | What you get                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `light` (default) | A summary above each function and class, plus comments only where the "why" isn't obvious |
| `medium`          | Everything in `light`, plus a short note for each logical block inside functions          |
| `heavy`           | Near line-by-line explanation, for people learning the language or the codebase           |

At every level the prompts ask for comments that explain why rather than
restate the code.

## Safe mode and refactor mode

**Safe mode** (the default, and the only mode outside the CLI) changes
formatting and adds comments, nothing else. The token check described under
[How it works](#how-it-works) proves it for every file; a file that fails the
check keeps only its formatting.

**Refactor mode** (`whycode fix --refactor`, or `"mode": "refactor"` with
`whycode fix`) lets the AI rewrite the whole file for readability. **Logic may
change**, so:

1. The file is formatted and sent to the AI, which returns the rewritten file
   and a list of what it changed, including any bug fixes.
2. The rewrite must still be valid code: the formatter must accept it and
   tree-sitter must parse it without errors. Otherwise the file is skipped.
3. If `testCommand` is set, it runs against the rewrite: WhyCode puts the
   rewritten file in place, runs the command from the project root, and always
   restores the original bytes afterwards, even when the tests fail or you
   press Ctrl+C (only a hard kill can leave the rewrite in place). Files are
   then processed one at a time. The command comes from `.whycoderc.json`, so
   only use it in repositories you trust.
4. Every file is shown with a warning, the change list and the test result,
   and needs your review; `--yes` is refused.

Languages without full support, and files with likely secrets (whose masks
can't be put back into rewritten code), are never sent in refactor mode.

## Supported languages

| Language   | Extensions                    | Formatter                                                                         | Notes                                                                                           |
| ---------- | ----------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Python     | `.py`, `.pyi`                 | [Ruff](https://docs.astral.sh/ruff/) (`ruff format`), found on PATH               | Without Ruff, comments are still added and verified; formatting is skipped with a warning.      |
| TypeScript | `.ts`, `.mts`, `.cts`         | Prettier (bundled)                                                                |                                                                                                 |
| TSX        | `.tsx`                        | Prettier (bundled)                                                                |                                                                                                 |
| JavaScript | `.js`, `.mjs`, `.cjs`, `.jsx` | Prettier (bundled)                                                                | JSX is supported in `.js` files.                                                                |
| Go         | `.go`                         | `gofmt` (comes with Go), found on PATH                                            | Without gofmt, comments are still added and verified; formatting is skipped with a warning.     |
| Rust       | `.rs`                         | `rustfmt`, found on PATH                                                          | Without rustfmt, comments are still added and verified; formatting is skipped with a warning.   |
| C#         | `.cs`                         | [CSharpier](https://csharpier.com/) (`csharpier`), found on PATH                  | Without CSharpier, comments are still added and verified; formatting is skipped with a warning. |
| Java       | `.java`                       | [google-java-format](https://github.com/google/google-java-format), found on PATH | Without it, comments are still added and verified; formatting is skipped with a warning.        |

Ruby, shell, Perl, R, C, C++, PHP, Kotlin, Swift, Scala, Dart, SQL, Lua and
Haskell get **comments only**: no formatting and no logic check, and every
result says so. Suggestions for their existing comments are limited to whole
comment lines.

Formatters use the project's own settings: Prettier reads `.prettierrc` and
`.editorconfig`, Ruff reads `pyproject.toml` or `ruff.toml`, rustfmt reads
`rustfmt.toml` or `.rustfmt.toml`, and CSharpier reads `.csharpierrc*` and
`.editorconfig`, all found from the file's location. rustfmt also gets the Rust
edition from the nearest `Cargo.toml` (2021 if there is none). gofmt and
google-java-format have no settings. google-java-format runs in layout-only
mode: it doesn't sort or remove imports, reorder modifiers, reflow long strings
or rewrite Javadoc, since those change more than layout.

**Go and cgo.** The comment block directly above `import "C"` is the cgo
preamble: C code that cgo compiles. Its text counts as part of the token
stream, so a comment inserted inside it, or next to it where it would join the
block, is caught. A comment separated from it by a blank line is fine.
Inserted comments always start with `// ` (with a space), so they can never
become a `//go:` directive.

**Rust doc comments.** To the compiler, `///`, `//!`, `/** */` and `/*! */` are
attributes, not comments, and the code examples in them run as tests. So each
doc comment counts as one token, and a comment inserted inside a block doc
comment is caught. A comment between two `///` lines is fine, and an inserted
comment can never become a doc comment for the same reason as above.

**Placement rules.** Comments are never placed directly after a line ending in
a backslash, which continues the line. Nor are they placed above a shebang
(`#!`) on line 1, which only works there, or above an encoding declaration
(`# -*- coding: latin-1 -*-`) on line 1 or 2, which Python only reads there.
Both are comments to tree-sitter, so verification alone wouldn't notice.

## How it works

`processFile({ path, code }, config, { provider, adapters })` handles one file
and returns a result. It never writes to disk.

1. **Privacy check:** files like `.env*`, `*.pem`, `*.key`, and SSH keys are
   skipped and never sent to an AI.
2. **Detect language** from the file extension:
   - A language with an adapter gets the full pipeline.
   - A known language without an adapter gets comments only, with no
     formatting and no verification, and the result is labeled that way.
   - Anything else is skipped.
3. **Format** with the language's formatter. If none is installed, WhyCode warns
   and carries on.
4. **Record the token stream**, ignoring comments (except where a comment is
   really code, such as Rust doc comments and Go's cgo preamble) and trailing
   commas that can't change meaning.
5. **Ask the AI for a comment plan.** Likely secrets are masked first. The AI
   returns JSON listing comments to insert and suggestions for existing
   comments; it never returns rewritten code. Providers that support it are
   held to a JSON schema. An invalid reply gets one retry, then the file is
   skipped.
6. **Insert comments** as new lines above their targets, then re-format.
   Existing lines are never edited. Comment text loses control characters and
   trailing backslashes, and every line break in it starts a new comment line.
7. **Verify:** the token stream must exactly match step 4. If it doesn't, or if
   the formatter rejects the code once the comments are in, the AI changes are
   thrown away and only the formatting is kept.
8. **Return** the new code (with the original line endings and byte-order
   mark), a unified diff, the suggestions for existing comments, and any
   warnings.

### What verification guarantees

`src/verification.test.ts` runs the real Python and TypeScript adapters over
`fixtures/*/verification.*`, a file per language full of risky constructs (Go,
Rust, C# and Java have their own `src/languages/<lang>.verification.test.ts`):

| Risk                                                                 | What happens                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Comment lands inside a multi-line string or template literal         | Caught: the string's contents changed, so the AI changes are discarded |
| Comment lands in JSX text                                            | Caught the same way                                                    |
| Comment after a backslash line continuation                          | Refused before insertion, with a warning                               |
| Comment above a line-1 shebang or a line-1/2 encoding declaration    | Refused before insertion, with a warning                               |
| Comment text containing newlines, `*/`, or code                      | Neutralized: every line becomes its own comment line                   |
| Comment between JSX attributes or inside a JSX expression            | Kept: it's valid code and the tokens don't change                      |
| A logic change slipping in (operator, identifier, removed statement) | Caught, and the warning names the first differing token                |
| A comment makes the formatter split a list and add a trailing comma  | Kept: a trailing comma that can't change meaning isn't a token         |
| A trailing comma that does change meaning, such as `(x)` to `(x,)`   | Caught                                                                 |

Switching off the token comparison makes every "caught" test fail, so the
suite really depends on it.

**Accepted suggestions** for existing comments go through the same check, and
may only take one of three shapes: whole comment lines (rebuilt exactly like
inserted comments), a line comment that ends a line of code (kept on one
line), or one `/* block comment */` (which keeps its line breaks when it sits
next to code, because in JavaScript a line break there can end a statement).
Python docstrings and Rust doc comments are code, so rewrites of them are
refused.

**Trailing commas.** Ruff and Prettier split a list one item per line and add a
trailing comma when a comment lands inside it. Each adapter lists the places
where a trailing comma can't change meaning, such as call arguments,
parameters, lists, dicts, objects and imports; a comma there, directly before
the closing bracket, is left out of the token stream. Where it does change
meaning it still counts: in Python `(x,)` is a tuple but `(x)` isn't, so tuples,
subscripts and tuple patterns only ignore the comma when they hold several
items; in TSX `<T,>` keeps its comma; a comma that marks a hole in a
JavaScript array always counts.

**Line numbers.** Inserted comment lines move the code below them, just as
reformatting does. Code that reads its own line numbers, such as Rust's
`line!()`, Python's `inspect` module, C#'s `[CallerLineNumber]`, or a stack
trace, sees different numbers. The tokens don't change, so verification can't
catch this. Likewise, C#'s `[CallerArgumentExpression]` captures an argument's
source text, comments included.

**C# and Java.** C# also ends a line at U+0085 (NEXT LINE), so comment text is
split there too. javac turns `\uXXXX` escapes into characters even inside
comments, so `// note \u000a code` would run `code`; the Java adapter keeps
every comment that contains `\u` in the token stream and also compares the code
as javac decodes it.

### AI providers

`createConfiguredProvider(config)` returns the provider named in config.

| `provider`            | Key (env var only)   | Sends code to                                                              |
| --------------------- | -------------------- | -------------------------------------------------------------------------- |
| `anthropic` (default) | `ANTHROPIC_API_KEY`  | Anthropic                                                                  |
| `openrouter`          | `OPENROUTER_API_KEY` | OpenRouter, which passes it to Anthropic                                   |
| `host`                | none                 | The AI inside VS Code (supplied by the extension via `createHostProvider`) |

- **API key:** read only from that provider's variable. If it's missing,
  creating the provider fails at once with a clear message, before any network
  call. The key never appears in warnings, errors, or skip reasons.
- **OpenRouter:** uses OpenRouter's Anthropic-compatible endpoint. Model IDs
  are translated (`claude-sonnet-5-5` becomes `anthropic/claude-sonnet-5.5`),
  and a model written as `vendor/name` is passed through as is.
- **Host AI:** `createHostProvider(name, sendPrompt)` turns a host's "send one
  prompt, get text back" chat model into a provider, folding the system prompt
  and the JSON schema into the prompt. Replies are validated like any other.
- **Structured output:** Claude's reply is constrained to the comment-plan JSON
  schema, and WhyCode still validates it.
- **Refusals:** with the `anthropic` provider and a model that supports it
  (Sonnet 5.5, Opus 5/5.5, Fable 5/5.1), server-side refusal fallback is on: if
  Claude declines a file for a safety reason, the API retries it on another
  model. A refusal that still stands skips the file with the reason.
- **Failures:** a rejected key, rate limiting, a missing model, or a network
  problem skips that file with a readable reason instead of stopping the run.
  The SDK retries rate limits and network errors twice first.

## Privacy and license

[PRIVACY.md](PRIVACY.md) says exactly what WhyCode sends to the AI provider,
what it never reads, how secrets are masked (and the limits of that), and that
it stores nothing.

MIT; see [LICENSE](LICENSE).

## Development

Requirements: Node.js 22.12 or newer and pnpm 12 (`npm install -g pnpm`).
Optional formatters on PATH enable their tests: Ruff, Go (`gofmt`), `rustfmt`,
CSharpier (`dotnet tool install -g csharpier`) and google-java-format (the
native build from its GitHub releases). Without them, those files still get
comments and verification, and the formatter tests are skipped.

```sh
pnpm install     # install dependencies
pnpm build       # build every package (bundles for cli, vscode, github-action)
pnpm test        # run all tests with Vitest
pnpm lint        # ESLint + Prettier check + type check (including tests)
pnpm format      # rewrite files with Prettier
```

The tests never call an AI service, except two live smoke tests that run only
when you opt in with `WHYCODE_LIVE_TESTS=1` and a key. Each makes a real,
billed request:

```sh
ANTHROPIC_API_KEY=sk-ant-... WHYCODE_LIVE_TESTS=1 pnpm test
OPENROUTER_API_KEY=sk-or-... WHYCODE_LIVE_TESTS=1 pnpm test
```

**Packaging.** Each front-end bundles the core with esbuild and ships the
tree-sitter grammars as `.wasm` files (with their MIT licenses), pointing the
core at them with `useGrammarDirectory`, so installing never runs the grammar
packages' install scripts, which try to compile native code. In the repository
the grammars come from the npm packages, and pnpm is told not to build their
native bindings (`allowBuilds` in `pnpm-workspace.yaml`).

- CLI: `pnpm --filter whycode verify-pack` packs the package, lists the tarball
  (only `dist/`, `README.md` and `LICENSE`), installs it globally into a
  throwaway folder and runs `whycode --version` and `--help`. Publish with
  `pnpm publish` from `packages/cli`, which turns the `workspace:*` dev
  dependency into a version.
- VS Code: `pnpm --filter whycode-vscode run package` builds the `.vsix`; a
  test loads the built bundle with `require()` and runs real clean-ups.
- GitHub Action: `pnpm --filter @whycode/github-action verify-bundle` runs the
  built bundle outside the workspace with fake GitHub and AI clients. A release
  must commit the built `dist/`; see the action's README.

### Task tracking

Tasks are tracked with [Backlog.md](https://github.com/MrLesk/Backlog.md) as
Markdown files in `backlog/` (install the CLI with `npm install -g backlog.md`).

```sh
backlog board            # Kanban board in the terminal
backlog browser          # web UI on http://localhost:6420
backlog task list --plain
```

Use the `backlog` CLI rather than editing task files by hand. `CLAUDE.md` and
`AGENTS.md` tell AI agents to do the same. Prettier skips `backlog/` and
`AGENTS.md` because the CLI writes them.

### Repository layout

```
packages/
  core/                  # the engine: all real logic, no UI
    src/
      pipeline.ts        # per-file pipeline (steps above)
      config.ts          # .whycoderc.json + flag overrides
      diff.ts            # unified diffs for previews
      verify.ts          # token-stream comparison
      privacy.ts         # sensitive-file check and secret masking
      line-suggestions.ts # changes as whole-line suggestions (GitHub Action)
      text.ts            # line-ending helpers
      process.ts         # runs external formatters
      test-runner.ts     # runs testCommand against a refactored file
      ai/                # providers (Anthropic, OpenRouter, host AI), schema,
                         # prompts, external-model.ts (an agent's model as the AI)
      comments/          # comment insertion, applying accepted suggestions
      files/             # file collection (.gitignore, globs), project root,
                         # reading and writing source files
      languages/         # adapters (python, typescript, go, rust, csharp,
                         # java), shared tree-sitter tokens, comments-only list
      testing/           # fake provider and toy adapter
    fixtures/            # messy AI-style sample code per language
  cli/                   # the `whycode` command (npm package "whycode")
    scripts/             # build.mjs (bundle + grammars), verify-pack.mjs
    src/                 # bin, cli (dispatch), args, run, check, fix,
                         # agent (prompt/preview/write), report
  claude-code-plugin/    # Claude Code plugin: no code, drives the CLI
    .claude-plugin/plugin.json
    skills/cleanup/SKILL.md
  vscode/                # VS Code extension ("whycode-vscode")
    scripts/             # build.mjs (CommonJS bundle, wasm, licenses)
    src/                 # extension, targets, projects, settings, ai,
                         # clean-up, review, proposals, report
  github-action/         # GitHub Action (action.yml)
    scripts/             # build.mjs, verify-bundle.mjs
    src/                 # main (GitHub edge), run, review
.claude-plugin/
  marketplace.json       # lets Claude Code install the plugin from this repo
```

### Toolchain notes

- **TypeScript is pinned to 6.0.x.** TypeScript 7 is out, but
  `typescript-eslint` only supports TypeScript below 6.1 so far. Move to 7 once
  `typescript-eslint` adds support.
- **Line endings are LF** everywhere (`.gitattributes`), so the Prettier check
  passes on Windows checkouts too.
