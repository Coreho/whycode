# whycode

Cleans up AI-written code so people can understand it: adds comments that
explain **what** the code does and **why**, checked so they can't change the
code, and formats it with your project's own formatter when the project uses
one. Every change is shown as a diff first, and nothing is written until you
accept it.

This is the command-line front-end of [WhyCode](https://github.com/Coreho/whycode#readme).
See the main README for how verification works, the full configuration
reference and the other front-ends.

## Install

```sh
npm install -g whycode
```

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
whycode check src             # dry run: diffs and suggestions, writes nothing
whycode fix src               # review each file's diff, write what you accept
whycode fix . --yes           # accept every file's changes without asking
whycode fix app.py --refactor # let the AI rewrite the code (logic will change)
```

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

| Flag                      | Effect                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--comment-level <level>` | `light` (default): summaries and non-obvious "why"; `medium`: also a note per block; `heavy`: near line-by-line, for learners |
| `--provider <name>`       | `anthropic` (default) or `openrouter`                                                                                         |
| `--model <id>`            | Claude model, default `claude-sonnet-5-5`                                                                                     |
| `--staged`                | Only files staged in git; a file with unstaged edits too is skipped                                                           |
| `--diff <ref>`            | Only files changed since the branch left `<ref>`                                                                              |
| `--format`                | Format even if the project hasn't adopted the formatter                                                                       |
| `--no-format`             | Never format; only add comments                                                                                               |
| `-y`, `--yes`             | `fix` only: accept every file's changes. Existing comments are still never edited automatically                               |
| `--refactor`              | `fix` only: the AI rewrites the code. Asks for confirmation (showing the exact `testCommand`), and every file needs review    |
| `-h`, `--help`            | Usage                                                                                                                         |
| `-v`, `--version`         | Version                                                                                                                       |

## Configuration

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
