# WhyCode

_Last updated: 2026-10-17_

WhyCode proposes explanatory comments for AI-written code and formats it with
the project's own formatter. You review the changes before applying them.

**Experimental and not yet published.** Generated comments can be incorrect,
redundant, or inconsistent across runs. Token checks on supported languages
check that comment edits preserve code tokens; they do **not** establish that
an explanation is true or that runtime behavior is unchanged in every case.
Review every proposed comment and run your project's tests. Usefulness and time
savings with independent developers have not yet been established.

Selected source files are sent to the configured AI provider. Secret masking
is a precaution, not a guarantee that sensitive data will be removed. See
[PRIVACY.md](PRIVACY.md) before using private code.

It comes as four front-ends that share one core engine: a CLI (`whycode`), a
Claude Code plugin, a VS Code extension and a GitHub Action.

## Start here

**[Install WhyCode and review your first file](QUICKSTART.md).**
The CLI is not on npm yet; the quickstart explains how to build and install it.
Start with `whycode demo`: a prepared, offline example that shows the original
code, a verified preview, simulated acceptance, and the result in a temporary
sample. No API key is required and your project files are not read or changed.

Then configure model access and run `whycode fix <one-file> --no-format` to
review your own file. Windows PowerShell users should use `whycode.cmd`.
See the [demo walkthrough](docs/demo.md) for what each step means.

## Status

The four front-ends are implemented and tested, with these distribution limits:

| Front-end          | State                                                             |
| ------------------ | ----------------------------------------------------------------- |
| CLI                | Packed and install-tested; first release will be `0.1.0-beta.1`   |
| Claude Code plugin | Validated, and run end to end in Claude Code from a checkout      |
| VS Code extension  | Packaged as a `.vsix`; the Marketplace publisher is a placeholder |
| GitHub Action      | Bundled and tested offline; needs a release with its `dist/`      |

## What WhyCode promises

- **Comment edits are checked for token preservation on supported languages.** WhyCode
  records the code's tokens (everything except comments, as tree-sitter
  parses it) before adding comments and compares them afterwards. If anything
  but comments changed, the comments are thrown away and only the formatting
  is kept. Formatting is done by the project's own formatter, and only when
  the project has adopted one (or you pass `--format`); `--no-format` skips it,
  so the only changes are checked comment insertions. The known limits: code
  that reads its own line numbers sees new numbers, files in languages WhyCode
  can only comment aren't checked, and refactor mode changes logic by design.
  [What verification guarantees](#what-verification-guarantees) has the
  details.
- **Existing comments are never edited automatically.** Improvements to them
  are offered as separate suggestions, each accepted on its own, and a
  suggestion can only change comment text.
- **Nothing is written without a preview.** Every front-end shows the diff
  first: an interactive prompt in the CLI, the diff view in VS Code, a diff in
  Claude Code, and review suggestions on the pull request.
- **Refactor mode is opt-in.** Only `whycode fix --refactor` lets the AI rewrite
  code, with a warning, a confirmation (which shows the exact `testCommand`
  that will run) and a review of every file.
- **File exclusions and secret masking reduce exposure.** Git-ignored files
  and files with recognized sensitive names are excluded. Likely secrets in
  selected source are masked before it is sent to the provider; unrecognized
  sensitive data can still be sent. [PRIVACY.md](PRIVACY.md) has the details.

## Front-ends

### CLI

```sh
whycode demo                        # offline prepared example; no key needed
whycode fix src/example.ts --no-format # first live review, after provider setup
whycode check src                   # preview only; no source writes
```

Build and install the CLI using the [quickstart](QUICKSTART.md).
The package is not published to npm yet.
For development, run `node packages/cli/dist/bin.js` after `pnpm build`.
The package's [README](packages/cli/README.md) doubles as its npm page.

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

| Flag                       | Effect                                                       |
| -------------------------- | ------------------------------------------------------------ |
| `--comment-level <level>`  | `light` (default), `medium` or `heavy`                       |
| `--provider <name>`        | `anthropic` (default) or `openrouter`                        |
| `--model <id>`             | Claude model, default `claude-sonnet-5-5`                    |
| `--staged`                 | Only files staged in git                                     |
| `--diff <ref>`             | Only files changed since the branch left `<ref>`             |
| `--format`                 | Format even if the project hasn't adopted the formatter      |
| `--no-format`              | Never format; only add comments                              |
| `--save-plan <file>`       | `check` only: save the comment plans for `fix --plan <file>` |
| `--plan <file>`            | `fix` only: apply a saved plan, no model request             |
| `--review-state <file>`    | Opt in to remembering reviews (see below)                    |
| `--refresh`                | With `--review-state`: ignore remembered reviews this run    |
| `--json`                   | Print one JSON report on stdout (see below)                  |
| `--trust-formatter-config` | Let Prettier run code from the project's config (see below)  |
| `-y`, `--yes`              | `fix` only: accept every file's changes                      |
| `--refactor`               | `fix` only: let the AI rewrite the code                      |
| `-h`, `--help`             | Usage                                                        |
| `-v`, `--version`          | Version                                                      |

**Results.** CLI previews are labeled “Nothing written to this file.” They
describe comments as proposed, show formatting and check information, and leave
existing-comment corrections as separate decisions. Only `Wrote <file>` and the
final written-files summary confirm a save. The underlying result categories
used by other front-ends and JSON reports are:

| Verdict                                                               | Meaning                                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| nothing to change                                                     | No changes proposed in this run; not a code-quality assessment              |
| N comments added; comment insertion preserved the checked code tokens | Comment insertions passed the token check; formatting is outside that check |
| formatting only (no comments were needed)                             | Only formatting proposed; the model proposed no new comments                |
| comments discarded because verification failed                        | The AI's comments were thrown away; at most formatting remains              |
| N comments added without verification                                 | A comments-only language, which WhyCode can't verify                        |
| rewritten by the AI, so logic may change                              | Refactor mode                                                               |
| not processed: _reason_                                               | The file failed, for example because the AI call did                        |

Suggested rewrites of existing comments are counted after the verdict, and
notes (such as discarded comments or a missing formatter) are always shown,
even when there is no diff.

**Changed files only.** `--staged` covers the files staged in git, and
`--diff <ref>` the files changed since the branch left `<ref>` (found with
`git merge-base`): committed, uncommitted and new untracked files, the way a
pull request would show them. Deleted files are left out and renamed files are
covered under their new name. Whole files are processed, not just the changed
lines, and the usual collection rules still apply. With either flag the paths
are optional and only narrow the changes. With `--staged`, both `check` and
`fix` skip a file that also has unstaged edits: WhyCode reads and writes the
working copy, which for that file isn't what will be committed. Besides the
summary, a warning on stderr counts those files, so a pre-commit hook shows
that they went unchecked; the exit code doesn't change. `fix --staged` doesn't
stage anything itself; at the end it prints the `git add` command for the
files it wrote.

**Review once, apply later.** `whycode check --save-plan review.json` saves the
AI's comment plan for each file, and `whycode fix --plan review.json` applies
exactly those plans with no new model request, showing the same diffs `check`
showed. The plan holds the validated replies and hashes only: no copy of the
source beyond the existing comments that suggestions quote. If a file, the
config, the prompt, the formatting or WhyCode itself changed since the plan
was saved, `fix` refuses before writing anything; run `check --save-plan`
again. A plan file is never overwritten.

**Remember reviews (opt-in).** By default WhyCode stores nothing. With
`--review-state <file>`, `fix` records each reviewed file's hash, its pending
suggestions for existing comments and the ones you rejected; later `check` or
`fix` runs with the same file skip the AI for files that haven't changed, keep
showing pending suggestions, and don't bring rejected ones back. Source, config,
prompt or tool changes invalidate the cached review; `--refresh` requests a fresh
review for one run. For unchanged source, exact rejected replacements at the same
comment location are still withheld after refresh or config/tool changes, with a
count in the output. A differently worded replacement, or one whose location
cannot be matched unambiguously after formatting/insertions, can still be offered.
Changing the source resets those decisions. To reset everything, delete the
state file. Likely secrets are masked both in stored suggestions and when matching
rejections. Keep the file out of version control if your comments are private.

For repeatable review and application, use the same state file on later runs:

```sh
whycode check src --save-plan review.json
whycode fix --plan review.json --review-state .whycode-review.json
whycode check src --review-state .whycode-review.json
```

**Comment accuracy.** The model is instructed to omit uncertain explanations,
check claims against branches and edge cases, and skip obvious validation in
light mode. Documented behavior of a library or platform the code calls counts
as a fact it may state; motives, incidents and business rules it can't see do
not. These are generation rules, not a proof that a comment is true.
Review explanations as well as diffs: token verification checks code preservation,
not factual accuracy. Repeated generation can produce different suggestions;
saved plans preserve an exact reviewed response, and review state can avoid
regenerating unchanged reviewed files. Neither establishes comment correctness.

**Exit codes:** `check` exits 0 when every file is clean, and 1 when a file
would change or had its comments discarded, so CI can use it as a gate.
`fix` exits 0 when it finishes, whatever you chose. Both exit 2 on errors: bad
usage, an invalid config, a missing API key, a path that doesn't exist, or a
file that couldn't be processed or written.

**JSON output.** `whycode check --json` and `whycode fix --yes --json` print
one JSON document on stdout, so CI and other tools never parse terminal text;
the usual text goes to stderr. `fix --json` needs `--yes`, since stdout can't
also hold the interactive review. On a usage error nothing is printed to stdout.

```json
{
  "tool": "whycode",
  "version": "0.1.0-beta.1",
  "command": "check",
  "exitCode": 1,
  "files": [
    {
      "path": "src/app.ts",
      "inputSha256": "…",
      "outputSha256": "…",
      "verdict": "verified",
      "verdictText": "2 comments added; comment insertion preserved the checked code tokens",
      "verification": { "method": "tokens", "outcome": "passed" },
      "commentsAdded": 2,
      "formatted": false,
      "warnings": [],
      "suggestions": []
    }
  ],
  "skipped": [{ "path": ".env", "reason": "…" }]
}
```

- `outputSha256` is the proposed code for `check`, and what is on disk
  afterwards for `fix`, which also sets `written`.
- `verdict` is `verified`, `unverified`, `discarded`, `unchanged`, `refactored`
  or `failed`, the same verdicts as the text output.
- `verification.method` is `tokens` (insertions were checked against the code's
  tokens) or `none` (a comments-only language); `outcome` is `passed`,
  `failed` or `not-run`.
- `suggestions` are the suggested rewrites of existing comments nobody
  accepted; `warnings` are the notes the text output shows.

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
  fingerprint (a full SHA-256) covers the file, the new code, the
  verification outcome, the notes and every suggested comment rewrite in
  order, so a plan whose suggestions changed after the preview is refused, and
  an accepted number always means the suggestion that was shown.

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
suggestions. Every run also writes a job summary (`$GITHUB_STEP_SUMMARY`) with
each file's verdict, even a clean run that posts no review. The key is masked
in the logs.

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
  "testCommand": null,
  "format": "auto"
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
| `format`       | `"auto"`                         | `"auto"`: format only with a formatter the project has adopted; `"always"` or `"never"`   |

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

| Level             | What you get                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `light` (default) | Uncluttered: a summary only where a function's or class's name and signature don't already say what it's for, plus comments where code is easy to break: ordering and timing, reliance on library or platform behavior, values nothing enforces, error handling that fails open or closed, and tests that depend on each other. Many functions get no comment |
| `medium`          | A summary above every function and class, the "why" comments, and a short note for each logical block inside functions                                                                                                                                                                                                                                        |
| `heavy`           | Near line-by-line explanation, for people learning the language or the codebase                                                                                                                                                                                                                                                                               |

At every level the prompts ask for comments that explain why rather than
restate the code.

## Safe mode and refactor mode

**Safe mode** (the default, and the only mode outside the CLI) changes
formatting and adds comments, nothing else. The token check described under
[How it works](#how-it-works) checks every comment insertion; a file that
fails the check keeps only its formatting. The formatting itself comes from
the project's own formatter and isn't token-checked, because formatters
legitimately change tokens (quote style, semicolons, parentheses); see
[What verification guarantees](#what-verification-guarantees) for the limits.

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
   only use it in repositories you trust; the confirmation before the run
   shows the exact command (hidden characters made visible) and the folder it
   runs in, or says that no tests will run.
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

**WhyCode only formats with a formatter your project uses.** Formatting style
is the project's choice, so by default a file is formatted only when its
project has adopted that language's formatter:

| Formatter          | Counts as adopted when the file's folder, or one above it within the repository, has                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prettier           | a Prettier config (`.prettierrc*`, `prettier.config.*`, a top-level `"prettier"` key in `package.json`) or Prettier in `package.json`'s dependencies |
| Ruff               | `ruff.toml`, `.ruff.toml`, or a `[tool.ruff]` section in `pyproject.toml` (Black settings alone don't count: Ruff doesn't read them)                 |
| CSharpier          | `.csharpierrc*`, CSharpier in `.config/dotnet-tools.json`, `Directory.Build.props` or a `.csproj`                                                    |
| google-java-format | google-java-format in `build.gradle`, `build.gradle.kts` or `pom.xml` (for example through Spotless)                                                 |
| gofmt, rustfmt     | always: they are the languages' standard                                                                                                             |

The search stops at the repository's top folder (the one with `.git`), so a
config in a folder above your project never decides its style. A malformed
`package.json` skips formatting with a note rather than guessing. A file that a
`.prettierignore` excludes (any one between the file and the repository's top
folder, its patterns read relative to its own folder) is never formatted, even
with `--format`.

**A project's formatter config never runs code without your say-so.** Prettier
runs a config written in JavaScript or TypeScript (`prettier.config.js`,
`.prettierrc.mjs` and the like), loads the plugins a config names, and loads a
shared config package a config points to by name. So on a repository someone
else wrote, formatting with its config could run its code. WhyCode checks for
these without asking Prettier and, if it finds one, skips formatting with a
note. `--trust-formatter-config` lets it run, for repositories you trust. The
flag can only come from you: a project's `.whycoderc.json` that sets
`trustFormatterConfig` is refused, and a saved plan never carries it. The
GitHub Action never runs it, since a pull request controls its own config. The
VS Code extension relies on workspace trust instead: it doesn't run in
untrusted workspaces. The other formatters (Ruff, gofmt, rustfmt, CSharpier,
google-java-format) read only declarative config and are run from your PATH.

Otherwise WhyCode adds comments without reformatting the file (still verified)
and says so, instead of burying a few comments under hundreds of lines of
reformatting. `--format` (or `"format": "always"`) formats anyway, and
`--no-format` (`"never"`) never formats. The agent commands take the same
flags, and `prompt`, `preview` and `write` must agree, because formatting
moves the line numbers a plan refers to; the commands `prompt` and `preview`
print for the next step carry the flag along.

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

To keep the result uncluttered, a comment aimed at a line that is already a
comment is dropped, since that code is already explained. A tool directive is
the exception (`// eslint-disable-next-line`, `// @ts-expect-error`, `//go:build`,
`# type: ignore` and the like): the explanation goes above it, never between
the directive and the code it controls. A comment aimed at the line right after a
next-line directive (`@ts-expect-error`, `eslint-disable-next-line`,
`prettier-ignore`, `pylint: disable-next` and the like) is moved above the
directive for the same reason; otherwise the directive would cover the comment
and its suppressed error would come back. Filler text such as "Placeholder",
"TODO" or "..." is dropped too. Each dropped comment is listed in the notes.

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
   held to a JSON schema. An invalid reply gets one retry that tells the model
   what was wrong with it (the system prompt stays the same, so it is still
   cached), then the file is skipped. Network and rate-limit errors are
   retried by the SDK, not again here.
6. **Insert comments** as new lines above their targets, then re-format.
   Existing lines are never edited. Comment text loses control characters,
   Unicode bidirectional controls (which could make a comment display
   differently from how the compiler reads the code around it) and trailing
   backslashes, and every line break in it starts a new comment line.
7. **Verify:** the token stream must exactly match step 4. If it doesn't, or if
   the formatter rejects the code once the comments are in, each comment is
   checked on its own with tree-sitter (no formatter run): the ones that would
   change the tokens are dropped with a warning naming their line, and the
   rest are inserted, formatted and verified once more. If that still fails,
   the AI changes are thrown away and only the formatting is kept. The
   formatter runs at most three times per file. Warnings quote the first
   differing token on one line: line breaks and hidden characters appear as
   escapes, and a long token is cut to the part around the difference.
8. **Return** the new code (with the original line endings and byte-order
   mark), a unified diff, the suggestions for existing comments, and any
   warnings.

### What verification guarantees

What is checked: inserting comments (and accepting a suggested rewrite of one)
leaves the code's tokens, as tree-sitter parses the formatted file, exactly as
they were. What isn't:

- **Formatting.** It is done by the project's own formatter, only when the
  project has adopted it (see [Supported languages](#supported-languages));
  `--no-format` skips it so that the only changes are checked comment
  insertions.
- **Code that reads its own line numbers.** Inserted lines move the code
  below them; see **Line numbers** below.
- **Comments-only languages.** Ruby, shell, C and the others in that list have
  no parser in WhyCode, so their comments are added without a check and the
  result says so.
- **Refactor mode.** It changes logic by design; only parsing and your
  `testCommand` check the rewrite.

`src/verification.test.ts` runs the real Python and TypeScript adapters over
`fixtures/*/verification.*`, a file per language full of risky constructs (Go,
Rust, C# and Java have their own `src/languages/<lang>.verification.test.ts`):

| Risk                                                                 | What happens                                                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Comment lands inside a multi-line string or template literal         | Caught: the string's contents changed, so that comment is dropped and the others are kept |
| Comment lands in JSX text                                            | Caught and dropped the same way                                                           |
| Comment after a backslash line continuation                          | Refused before insertion, with a warning                                                  |
| Comment above a line-1 shebang or a line-1/2 encoding declaration    | Refused before insertion, with a warning                                                  |
| Comment text containing newlines, `*/`, or code                      | Neutralized: every line becomes its own comment line                                      |
| Comment between JSX attributes or inside a JSX expression            | Kept: it's valid code and the tokens don't change                                         |
| A logic change slipping in (operator, identifier, removed statement) | Caught, and the warning names the first differing token                                   |
| A comment makes the formatter split a list and add a trailing comma  | Kept: a trailing comma that can't change meaning isn't a token                            |
| A trailing comma that does change meaning, such as `(x)` to `(x,)`   | Caught                                                                                    |

Switching off the token comparison makes every "caught" test fail, so the
suite really depends on it.

**Accepted suggestions** for existing comments go through the same check, and
may only take one of these shapes: whole comment lines (rebuilt exactly like
inserted comments; a quote that joins the lines into one sentence is matched
word by word and the rewrite is wrapped to their width), a line comment that
ends a line of code (kept on one line), one `/* block comment */` (which keeps
its line breaks when it sits next to code, because in JavaScript a line break
there can end a statement), or text quoted from inside a block comment on lines
of its own, such as a JSDoc paragraph. That last shape replaces only the quoted
words, which must appear in the comment exactly once, keeps the markers and
`*` prefixes, and re-wraps the rest of the paragraph to its width.
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
- **Errors:** when the service refuses a request, the message includes its
  own reason (for example OpenRouter's "Key limit exceeded"), on one line and
  without any links, since a provider may link to the key's settings page.
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
