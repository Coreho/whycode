# Try WhyCode

Start with one file: see a proposed explanation, review it, then decide whether
to save it. WhyCode is an experimental beta. Comments can be wrong; a passing
token check does not establish their accuracy.

## 1. Install the CLI

You need **Node.js 22.12 or newer** (which includes npm) and an internet
connection for installation.

**Windows PowerShell**

```powershell
npm.cmd install --global @koreokorp/whycode@beta
whycode.cmd --version
whycode.cmd demo
```

**macOS / Linux**

```sh
npm install --global @koreokorp/whycode@beta
whycode --version
whycode demo
```

The demo makes **no model requests**, needs **no API key**, and works only on
a temporary sample. It uses a prepared response and prints its simulated
acceptance. Your project files are not read or changed. Read the
[demo walkthrough](docs/demo.md) for an explanation of each step.

## 2. Choose model access

**Already using Claude Code?** Install the CLI above, then follow the
[Claude Code plugin setup](https://github.com/Coreho/whycode/blob/main/packages/claude-code-plugin/README.md#install).
It uses your existing host model. You can skip API-key setup below.

**Using the CLI directly?** Supply an Anthropic API key. Requests use your API
account and incur provider charges. A chat subscription alone does not supply
API access.

PowerShell (masked input; key lasts for this terminal session):

```powershell
$whycodeApiKey = Read-Host 'Anthropic API key' -AsSecureString
$env:ANTHROPIC_API_KEY = [System.Net.NetworkCredential]::new('', $whycodeApiKey).Password
Remove-Variable whycodeApiKey
```

Bash (masked input):

```bash
read -rs -p 'Anthropic API key: ' ANTHROPIC_API_KEY
export ANTHROPIC_API_KEY
printf '\n'
```

In zsh, use `read -s 'ANTHROPIC_API_KEY?Anthropic API key: '` followed by
`export ANTHROPIC_API_KEY` and `printf '\n'`.

OpenRouter is also supported: set `OPENROUTER_API_KEY` instead, and add
`--provider openrouter --model <your-provider-model-id>` to your command.

## 3. Review one of your files

Open a terminal in your project. Choose a small JavaScript or TypeScript file
whose code you have permission to send to the provider. Selected source is
sent to that provider; secret masking can miss sensitive content.

Replace `src/example.ts` with your actual file:

```powershell
whycode.cmd fix src/example.ts --no-format
```

On macOS/Linux, use `whycode` instead of `whycode.cmd`.

This first run leaves formatting out so the proposed explanations are easy to
see. The default comment level is light. A live model can propose different
comments or none; the demo is not a prediction of your result.

- **Preview · Nothing written to this file:** these are proposed edits.
- **New comment edits preserved the checked code tokens:** the insertion passed
  its token check. Read the explanation yourself to judge whether it is true
  and useful. This does not guarantee every aspect of runtime behavior.
- **Apply these changes?** `y` accepts the new comments shown; `n` rejects them;
  `s` skips the file; `q` stops review. New comments are reviewed as one batch.
- **Existing-comment corrections:** reviewed separately, one at a time.
- **Wrote …:** the accepted result has now been saved. The summary shows which
  files were written. A proposal alone is never proof of a write.

After accepting, inspect the resulting file or Git diff and run your project's
tests. If a new comment needs editing, edit it normally in your editor.

Once this feels clear, omit `--no-format` to allow the project's adopted
formatter. Formatting is separate from the comment token check.

## Other outcomes

| Message                                        | Meaning / next step                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| No changes proposed                            | This run has no edits to offer. It is not a code-quality certification.                             |
| Comments discarded because verification failed | Those new comments will not be written. Read the notes; formatting may still be offered if enabled. |
| Added/proposed without verification            | This language has comments-only support. Use a fully supported language for your first trial.       |
| Not processed / missing key                    | The run did not produce a usable result. Fix the stated issue and retry.                            |

## If installation gets stuck

- **`EEXIST` for `whycode.cmd` after installing an earlier local archive:**
  run `npm.cmd uninstall --global whycode`, then retry
  `npm.cmd install --global @koreokorp/whycode@beta`. The old unscoped package
  and the published scoped package use the same command name.
- **PowerShell blocks scripts:** use `npm.cmd` and `whycode.cmd` as shown;
  no execution-policy change is needed.
- **Command not found after installation:** reopen the terminal. npm puts
  global executables in the folder printed by `npm prefix --global` on Windows,
  or its `bin` subfolder on macOS/Linux. That folder must be on your PATH.
- **Permission denied during global installation:** use a directory you own,
  for example `npm install --global --prefix ./whycode-local @koreokorp/whycode@beta`.
  Run `./whycode-local/bin/whycode demo` on macOS/Linux or
  `.\whycode-local\whycode.cmd demo` on Windows (use `npm.cmd` there).
- **Model unavailable:** use `--model` with a model your configured provider
  makes available.
