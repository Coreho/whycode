# WhyCode for VS Code

Cleans up AI-written code so people can understand it: adds comments that
explain **what** the code does and **why**, checked so they can't change the
code, and formats it with your project's own formatter when the project uses
one. Every change opens in VS Code's diff view first, and nothing is written
until you apply it.

This is the VS Code front-end of
[WhyCode](https://github.com/Coreho/whycode#readme). See the main README for
how the token check works, the full `.whycoderc.json` reference and the other
front-ends (CLI, Claude Code plugin, GitHub Action).

## Commands

- **WhyCode: Clean Up Current File** (Command Palette, or right-click in the
  editor) cleans up the file in the active editor.
- **Clean Up with WhyCode** (right-click in the Explorer) cleans up the
  selected files and folders. Select several to do them in one run.

WhyCode works on files as they are saved on disk: a file with unsaved edits is
skipped until you save it. Progress shows in a notification, which you can
cancel; cancelling writes nothing.

## Reviewing changes

For each file with changes, WhyCode opens the diff between the file and its
proposal and asks:

- **Apply** writes the proposal to the file.
- **Discard** leaves the file as it is.
- **Stop** (or Escape) leaves this file and every remaining one as they are.

A file is only written if it hasn't changed since WhyCode read it, so edits you
make during the review are never overwritten.

Existing comments are never changed on their own. When the AI thinks one is
wrong or out of date, it suggests a rewrite, and WhyCode lists the suggestions
with the current text and the reason. Nothing in the list is ticked: only the
rewrites you tick are applied. Suggestions are offered when you apply the
file's changes, or when the file has no other changes.

The extension only runs WhyCode's safe mode: formatting by the project's own
formatter, plus comments that are checked to leave the code's tokens
(everything except comments) unchanged. Code that reads its own line numbers
still sees new numbers, because inserted lines move the code below them.
Refactor mode is CLI-only (`whycode fix --refactor`); a `"mode": "refactor"`
in `.whycoderc.json` is ignored here, with a note in the output.

## Settings

| Setting                | Values                                      | Default |
| ---------------------- | ------------------------------------------- | ------- |
| `whycode.commentLevel` | `light`, `medium`, `heavy`                  | `light` |
| `whycode.provider`     | `auto`, `vscode`, `anthropic`, `openrouter` | `auto`  |

`whycode.commentLevel` overrides `commentLevel` in `.whycoderc.json` when you
set it; when you don't, the file's value is used. Everything else (`include`,
`exclude`, `model`) comes from `.whycoderc.json` at the project root, which is
the git root of the workspace folder.

## How the AI is chosen

With `whycode.provider` set to `auto`:

1. If a VS Code language model is available (for example from GitHub
   Copilot), WhyCode uses it, preferring the model named in `.whycoderc.json`,
   then any Claude model. VS Code asks once for your permission.
2. Otherwise it uses the API key provider from `.whycoderc.json`: the
   Anthropic API with `ANTHROPIC_API_KEY` by default, or OpenRouter with
   `OPENROUTER_API_KEY`.

`vscode` always uses a language model, and `anthropic` or `openrouter` always
use that API key. Keys are read only from the environment VS Code was started
with (start VS Code from a terminal where the variable is set). WhyCode never
stores a key in settings, secret storage, files or logs. Which model answered
is shown in the **WhyCode** output channel.

## Privacy

- Files ignored by `.gitignore` and files that may hold secrets (`.env*`,
  `*.pem`, `*.key` and the like) are never read or sent to an AI.
- Likely secrets (API keys, tokens) inside a file are masked before it is
  sent.
- The **WhyCode** output channel lists skipped files with the reason and any
  failures, but never file contents: core messages are cut to their first line
  with quoted code masked.
- The extension doesn't run in untrusted (Restricted Mode) workspaces, because
  formatters read config files that can run code from the workspace.

## Languages

Python, JavaScript, TypeScript, Go, Rust, C# and Java get formatting plus a
check that adding comments leaves the code's tokens unchanged. JavaScript and
TypeScript are formatted with the bundled Prettier; the other formatters (Ruff, gofmt,
rustfmt, CSharpier, google-java-format) are used when they're on your PATH.
Without one, files still get comments and the token check. Ruby, shell, C,
C++, PHP, Kotlin, Swift, SQL and a few others get comments only, without the
check, clearly labeled in the review.

## License

MIT. The bundled libraries' licenses are in `dist/THIRD-PARTY-LICENSES.txt`.
