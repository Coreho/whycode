# WhyCode GitHub Action

Runs WhyCode on files changed in a pull request and posts **one COMMENT review**
with individually applicable `suggestion` blocks. The review is the preview:
authors choose which suggestions to apply. The action never edits source files,
creates commits, or pushes to the branch. A clean run with no suggestions,
skips, or warnings posts nothing; suggestions do not fail the step.

See the [project README](../../README.md) for the engine, supported languages,
configuration, and verification guarantees.

## Example workflow

This example uses the release layout described below. Replace
`YOUR_ORG/whycode@ACTION_RELEASE_SHA` with a published action release's immutable
commit SHA. Source branches omit `dist/` and cannot be used directly as actions.

```yaml
name: WhyCode review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: whycode-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    # Repository secrets and a writable token are unavailable to ordinary fork PRs.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          persist-credentials: false
      - uses: YOUR_ORG/whycode@ACTION_RELEASE_SHA
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          github-token: ${{ github.token }}
          comment-level: light
```

Checkout **the PR head**, not the default synthetic merge commit. The action
compares `git rev-parse HEAD` with the event and API head SHA, checks each file's
Git blob hash against the PR files list, and checks the API head again before
posting. Changed or dirty checkouts are rejected or summarized as skipped files.
Use LF checkout settings (`core.autocrlf=false`) so blob hashes match.

The workflow needs `contents: read` and `pull-requests: write`. Run only on trusted
PRs: repository formatter configuration can load executable plugins. Do not
switch this example to `pull_request_target` to expose secrets to fork code.
The action itself accepts only `pull_request` events. Other events exit without
reading keys, processing files, or posting reviews.

## Inputs

| Input               | Default                                      | Meaning                                                       |
| ------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| `anthropic-api-key` | `ANTHROPIC_API_KEY` environment variable     | Pass `${{ secrets.ANTHROPIC_API_KEY }}`; never a literal key. |
| `github-token`      | `${{ github.token }}`                        | Token with the permissions above.                             |
| `comment-level`     | Repository config, then `light`              | `light`, `medium`, or `heavy`.                                |
| `model`             | Repository config, then core's default model | Anthropic model ID.                                           |

Instead of the key input, the action step can set
`env: { ANTHROPIC_API_KEY: '${{ secrets.ANTHROPIC_API_KEY }}' }`.
Inputs are transported as environment variables by GitHub. Keys are passed to
core only through its environment option and masked with `core.setSecret`
before processing. They are never saved to configuration or printed.

`.whycoderc.json` at the checked-out workspace root supplies include/exclude
patterns, comment level, and model. This front-end always overrides `mode` to
`safe`, `provider` to `anthropic`, and `testCommand` to `null`; it never executes
refactor-mode test commands. Invalid inputs/configuration, missing keys, checkout
head mismatches, and GitHub API errors fail the step. Per-file read/processing or
verification failures are reported in the review instead.

## Privacy and review behavior

- Only paths returned by the paginated `pulls.listFiles` endpoint are collected.
  Removed files are skipped; renames use their new paths.
- Every source read goes through core's `collectFiles`: nested `.gitignore`,
  `.git/info/exclude`, include/exclude patterns, sensitive-file refusals
  (`.env*`, `*.pem`, `*.key`, credentials), symlinks, and size limits apply.
  Refused source files are never read or sent to the provider.
- Eligible **whole files** are sent to Anthropic, with core's secret redaction,
  so it can understand context. This is changed-file scope, not changed-lines-only
  transmission. The AI's generated comments appear on the PR for human review.
- Files with `verification === "failed"` or processing failures get no
  suggestions, including any formatting fallback. The summary identifies them.
  Languages with comments-only support are labeled as unverified.
- Only complete RIGHT-side PR hunks (including their visible context lines) can
  anchor suggestions. Every original line being replaced must fit in one hunk.
  Insertions above line N include line N as their anchor; multiline replacements
  use `start_line`/`line`. Each resulting block is applicable independently.
- Edits outside the PR diff are **counted per file** in the summary. Missing or
  truncated API patches, empty-file edits, and changes involving a missing final
  newline cannot produce safe suggestions and are summarized too. Exact
  indentation, trailing spaces, blank lines, and CRLF content are preserved;
  final-newline changes are withheld rather than silently changing text.
- Existing-comment rewrites are validated separately by core and mapped from
  output lines back to the PR head. Rewrites outside the diff, overlapping other
  suggestions, or without a safe mapping are counted in the summary. They never
  get folded into the automatic formatting/new-comment preview.
- Reviews contain at most 50 suggestions; individual comment bodies are capped
  at 60 KB and the summary at approximately 59 KB. Omitted suggestions/summary
  entries are counted. PRs reaching the API's 3,000-file cap fail explicitly.
  Later runs create another review; existing reviews are not edited or deduplicated.

External formatters (Ruff, gofmt, rustfmt, CSharpier, google-java-format) are
optional runner tools. When absent, the engine warns and still adds/verifies
comments. Prettier, parsers, the Anthropic SDK, and both Actions SDKs ship inside
the bundle. Third-party formatter plugins, if configured, must be available in
the checked-out repository.

## Build, verify, and publish a release

`dist/` is intentionally gitignored in the source worktree. GitHub downloads an
action's Git ref and immediately runs `dist/index.cjs`; it does **not** install
dependencies or download a release asset automatically.

From the monorepo root:

```sh
pnpm install --frozen-lockfile
pnpm format
pnpm build
pnpm test
pnpm lint
pnpm --filter @whycode/github-action verify-bundle
```

The build uses esbuild to bundle all JavaScript dependencies into CommonJS,
copies every grammar's `.wasm` and LICENSE into `dist/grammars/`, and places
`web-tree-sitter.wasm` beside the bundles. Prettier's parser modules and license
are included. Runtime grammar lookup uses the shipped directory and never loads
native `tree-sitter-*` packages. Metadata uses GitHub's newest supported runtime,
[`node24`](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax#runsusing-for-javascript-actions).
Build tools also run on the project's Node 22.12+ baseline.

`verify-bundle` copies only `dist/` plus the smoke harness to a new temporary Git
repository outside the workspace. A fresh Node process reads a fake event,
uses fake Octokit pagination/review methods and a fake provider, and processes
Python and TypeScript with real WASM tokenization and bundled Prettier. It asserts
that suggestions are posted and source bytes are unchanged. The Vitest suite
includes this check; no API key or network is needed.

To publish, a release job should stage **this package's** `action.yml`, README,
and built `dist/` together at the root of a separate distribution repository or
release-only Git branch. Publish that staged tree as an immutable release commit
and tag (for example `action-v1.0.0`). Point consumers at its SHA, as above.
The release ref must include the generated bundle even though the source branch
does not track it. Keep source commits free of `dist/`; uploading a ZIP asset
alone is insufficient. No publishing, committing, or pushing is performed by
the action's build or verification scripts.
