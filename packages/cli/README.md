# whycode

Proposes explanatory comments for AI-written code and formats it with your
project's own formatter when the project uses one. Every change is shown as a
diff first, and nothing is written until you accept it.

**Experimental beta.** Generated comments can be incorrect,
redundant, or inconsistent across runs. Token checks on supported languages
check code-token preservation, not factual accuracy or every aspect of runtime
behavior. Review the explanations and run your project's tests before keeping
changes. Usefulness and time savings with independent developers are unproven.

Selected source files go to the configured AI provider. Secret masking can miss
sensitive data; read the [privacy documentation](https://github.com/Coreho/whycode/blob/main/PRIVACY.md)
before using private code.

This is the command-line front-end of [WhyCode](https://github.com/Coreho/whycode#readme).
See the main README for how verification works, the full configuration
reference and the other front-ends.

## Install

Install the beta directly from npm. Follow the
[quickstart](https://github.com/Coreho/whycode/blob/main/QUICKSTART.md) for
PowerShell and shell instructions, provider setup, and your first file.

```sh
npm install --global @koreokorp/whycode@beta
whycode demo
```

On Windows PowerShell use `npm.cmd` and `whycode.cmd`. The demo makes no model
requests and needs no key. It labels its prepared response and simulated
acceptance, uses the real verification pipeline, and writes only a temporary
sample. Live results may differ.

Needs Node.js 22.12 or newer. Languages with full support (formatting plus a
check that adding comments leaves the code's tokens unchanged): Python, JavaScript, TypeScript, Go,
Rust, C# and Java. JavaScript and TypeScript are formatted with the bundled
Prettier. The other formatters are used when they're on your PATH:
[Ruff](https://docs.astral.sh/ruff/) (Python), `gofmt` (Go), `rustfmt` (Rust),
[CSharpier](https://csharpier.com/) (C#) and
[google-java-format](https://github.com/google/google-java-format) (Java).
Without one, files still get comments and the token check; only formatting
is skipped. Ruby, shell, C, C++, PHP, Kotlin, Swift, SQL and a few others get
comments only, clearly labeled.

## What is checked

Before adding comments, WhyCode records the code's tokens (everything except
comments, as tree-sitter parses it), and compares them afterwards. If anything
but comments changed, the comments are discarded and only the formatting is
offered. The formatting itself is done by your project's formatter, and only
when the project has adopted it (a config file or dependency); `--no-format`
skips it, so the only changes are checked comment insertions.

Known limits: code that reads its own line numbers (stack traces, Python's
`inspect`, Rust's `line!()`) sees new numbers, because inserted lines move
the code below them; comments-only languages aren't checked, and their results
say so; and `--refactor` changes logic by design.

## API key

WhyCode asks Claude where comments belong. Set one key in your environment;
it is never written to disk or logs:

```sh
export ANTHROPIC_API_KEY=sk-ant-...      # default provider
export OPENROUTER_API_KEY=sk-or-...      # with --provider openrouter
```

## Commands

```sh
whycode demo                            # offline prepared walkthrough
whycode fix src/example.ts --no-format # review one file after setting your key
whycode check src                      # dry run: writes no source changes
```

The preview says **Nothing written to this file**. New comments are proposed
as a batch; existing-comment corrections are separate decisions. **Wrote ...**
confirms a save. **No changes proposed** is a result for this run, not a claim
that the file needs no improvements. Formatting is outside the comment token
check, and explanation accuracy always needs your review.

- **`check <paths...>`** prints a diff per file that would change, suggested
  rewrites of existing comments, and why any paths were skipped. Exit code 0
  means nothing would change and 1 means something would, so it works as a CI
  gate.
- **`fix <paths...>`** shows each diff and asks `[y]es / [n]o / [s]kip /
[q]uit`, then offers suggested rewrites of existing comments one at a time.
  It writes only what you accept, keeps your line endings, and never
  overwrites a file you edited meanwhile. Without a terminal it writes nothing
  unless you pass `--yes`.

Exit code 2 means an error: bad usage, an invalid config, a missing API key,
a path that doesn't exist, or a file that couldn't be processed.

| Flag                       | Effect                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `--comment-level <level>`  | `light` (default): summaries, non-obvious "why" and easy-to-break code; `medium`: also a note per block; `heavy`: near line-by-line |
| `--provider <name>`        | `anthropic` (default) or `openrouter`                                                                                               |
| `--model <id>`             | Claude model, default `claude-sonnet-5-5`                                                                                           |
| `--staged`                 | Only files staged in git; a file with unstaged edits too is skipped                                                                 |
| `--diff <ref>`             | Only files changed since the branch left `<ref>`                                                                                    |
| `--format`                 | Format even if the project hasn't adopted the formatter                                                                             |
| `--no-format`              | Never format; only add comments                                                                                                     |
| `--json`                   | Print one JSON report on stdout (hashes, verdicts, verification, warnings); `fix` needs `--yes`                                     |
| `--trust-formatter-config` | Let Prettier run code from the project (a JavaScript config, plugins); off by default, and a project can't turn it on itself        |
| `-y`, `--yes`              | `fix` only: accept every file's changes. Existing comments are still never edited automatically                                     |
| `--refactor`               | `fix` only: the AI rewrites the code. Asks for confirmation (showing the exact `testCommand`), and every file needs review          |
| `-h`, `--help`             | Usage                                                                                                                               |
| `-v`, `--version`          | Version                                                                                                                             |

## Configuration

For a repeatable review, run `whycode check src --save-plan review.json`, then
`whycode fix --plan review.json --review-state .whycode-review.json`. Applying a
saved plan makes no model request. Later checks/fixes with the same
`--review-state` reuse unchanged reviews and keep pending corrections visible.
`--refresh` requests fresh model output but still withholds exact rejected
replacements for unchanged source. Config or tool changes also retain these
rejections; source edits reset them. Different replacement wording can still be
offered. Keep the state file out of version control if comments are private.

Light mode asks the model to omit uncertain explanations and obvious validation.
Comments still need factual review: preserving code tokens does not establish
that an explanation is true.

Put a `.whycoderc.json` at your repository root; flags override it:

```json
{
  "commentLevel": "light",
  "include": ["src/**"],
  "exclude": ["**/*.test.*", "dist/**"],
  "provider": "anthropic",
  "model": "claude-sonnet-5-5",
  "testCommand": "npm test"
}
```

`testCommand` runs in a shell against each refactored file in `fix --refactor`,
and the result is shown with its diff. It comes from the repository, so the
confirmation shows the exact command first.

## Privacy

Files ignored by `.gitignore` and files that may hold secrets (`.env*`,
`*.pem`, `*.key`, SSH keys and the like) are never read. In the files that
are sent, likely secrets such as API keys and tokens are masked first. Only
the code of the files you name is sent to the AI provider you choose.

## License

MIT. The bundled tree-sitter grammars are MIT-licensed too; their licenses are
in `dist/grammars/`.
