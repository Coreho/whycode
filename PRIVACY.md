# Privacy

_Last updated: 2026-10-15_

WhyCode sends your source code to an AI model so the model can write comments
for it. This page says what leaves your machine, what never does, and where it
goes. It covers the `whycode` CLI and the core engine that every WhyCode
front-end shares.

WhyCode has no servers, no accounts and no telemetry. The only network
requests it makes go to the AI provider you choose.

## What is sent

WhyCode sends a request for each file it processes. A request holds that one
file and nothing from any other file:

- The file's path relative to the project root (for example `src/app.py`) and
  its language. Paths are not masked.
- The file's code, formatted if a formatter is available, with likely secrets
  masked (see [Secret masking](#secret-masking)). Every line is prefixed with
  its line number so the AI can say where each comment goes. Existing comments
  are part of the code, so they are sent too.
- WhyCode's own instructions (the system prompt) and the JSON format the reply
  must follow. These are the same for every file and contain none of your
  code.
- Your API key, which the provider needs to accept the request. The Anthropic
  SDK that WhyCode uses also sends its version and your operating system, CPU
  architecture and Node.js version in request headers.

Some cases differ:

- **Languages without full support** (Ruby, shell, C, SQL and the others that
  get comments only) are sent without formatting, still masked.
- **Refactor mode** (`whycode fix --refactor`) sends the formatted file without
  line numbers. A file in which WhyCode finds a likely secret is not sent at
  all, because masked values can't be put back into rewritten code. Languages
  without full support are not sent in refactor mode.
- **Retries:** a file can be sent more than once. WhyCode asks again once if
  the reply isn't valid, and the Anthropic SDK retries up to twice on errors
  such as rate limits and network failures.

## What is never sent

WhyCode picks the files it may read before it reads any of them. These files
are never read, so they are never sent:

- **Files git ignores**, according to your global excludes file (git's
  `core.excludesFile`, or `~/.config/git/ignore`), the repository's
  `info/exclude` (also in worktrees and submodules), and every `.gitignore`
  from the project root down (deeper files win). A file inside an ignored
  folder is ignored too. This holds even when you name the file on the command
  line. Ignore files of repositories nested inside the project aren't read, so
  keep rules that protect secrets in the project's own `.gitignore`.
- **Files whose names suggest secrets**, in any folder and even when you name
  them directly (names are matched ignoring case):
  - `.env` and `.env.*`, such as `.env.local` and `.env.production`
  - files ending in `.pem`, `.key`, `.p12`, `.pfx`, `.jks` or `.keystore`
  - SSH keys: names starting with `id_rsa`, `id_dsa`, `id_ecdsa` or
    `id_ed25519`
  - `.npmrc`, `.pypirc` and `.netrc`
- **Anything inside the `.git` folder.**
- **Symbolic links.** WhyCode skips them instead of following them, including
  paths that pass through a linked folder.
- **Files larger than 1 MB.**
- **Files outside the project root**, which is the git repository's top folder,
  or else the nearest folder with a `.whycoderc.json`.
- **Files your config leaves out:** those matched by `exclude`, or not matched
  by `include`, in `.whycoderc.json`. By default `node_modules/` and `dist/`
  are excluded.
- **Files that aren't source code in a language WhyCode handles**, such as
  `.json`, `.yaml`, `.toml`, `.ini`, `.xml` and `.properties` files.

Binary files and files that aren't valid UTF-8 are read to find that out, then
skipped without being sent. The core checks file names again just before any
AI request, so a front-end that hands it a file directly still can't send one
of the files listed above.

Besides the files it processes, WhyCode reads only settings, and never sends
them: `.whycoderc.json`, the git ignore files above, `Cargo.toml` (for the
Rust edition) and formatter settings such as `.prettierrc`, `.editorconfig`
and `rustfmt.toml`.

## Secret masking

Before code is sent, WhyCode replaces likely secrets with `[REDACTED]`:

- **Private key blocks:** every line between `-----BEGIN ... PRIVATE KEY-----`
  and `-----END ... PRIVATE KEY-----`, including PGP's
  `-----BEGIN PGP PRIVATE KEY BLOCK-----`. The BEGIN and END lines stay.
- **Known token formats:**
  - Anthropic keys (`sk-ant-...`) and other keys starting with `sk-` or
    `sk-proj-`, such as OpenAI and OpenRouter keys
  - AWS access key IDs (`AKIA...`, `ASIA...`)
  - GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`)
  - Slack tokens (`xoxa-`, `xoxb-`, `xoxp-`, `xoxr-`, `xoxs-`)
  - Google API keys (`AIza...`)
  - Stripe secret and restricted keys (`sk_live_`, `sk_test_`, `rk_live_`,
    `rk_test_`)
- **Secret-looking assignments:** a value of 8 or more characters assigned
  with `=`, `:` or `:=` to a name containing `api_key` (or `api-key`,
  `apikey`), `secret`, `token`, `password` or `passwd`, in any case. The value
  is masked when it is in quotes (`"`, `'` or backticks), as in
  `DB_PASSWORD = "..."`, `"client_secret": "..."` or Go's `password := "..."`,
  or when it is unquoted and ends its line, as in a shell script's
  `export API_TOKEN=...`. Only the value is replaced.
- **Passwords in URLs:** the password part of addresses such as
  `postgres://user:password@host`.

Masking never adds or removes lines, so the line numbers the AI replies with
still match your file. When something was masked, WhyCode's output for that
file says how many secrets it masked. Error messages from the provider are
masked the same way, with your API key removed, before WhyCode prints them.

Masking is best effort. It works by matching patterns, so secrets in other
forms can get through, for example:

- values shorter than 8 characters
- unquoted values followed by more code on the same line
- tokens from services not listed above, under names that don't sound secret

Masking errs on the side of caution, so it sometimes masks ordinary code that
looks like a secret (for example `TOKEN_URL = BASE_URL`). That only affects
what the AI sees, never your file.

Don't rely on masking alone. Keep secrets out of source files, for example in
an ignored `.env` file or a secrets manager.

## Where it goes

The `provider` setting in `.whycoderc.json`, or the `--provider` flag, decides
where requests go:

- **`anthropic`** (the default) sends requests to the Anthropic API at
  `https://api.anthropic.com`, with the key from `ANTHROPIC_API_KEY`. The
  Anthropic SDK honors the `ANTHROPIC_BASE_URL` environment variable: if you
  set it, requests go to that address instead. With some models, if Claude
  declines a file, the Anthropic API may retry it on another model that
  Anthropic chooses.
- **`openrouter`** sends requests to OpenRouter at `https://openrouter.ai/api`,
  with the key from `OPENROUTER_API_KEY`. OpenRouter passes them on to the
  model's vendor: Anthropic for Claude models, or the vendor you name if you
  set a model in `vendor/name` form. `ANTHROPIC_API_KEY` is never sent to
  OpenRouter.

Keys are read only from those environment variables. `.whycoderc.json` has no
setting for a key and rejects unknown settings. WhyCode never writes a key to
disk, and if the key is missing it stops before making any request.

WhyCode asks the provider to cache its system prompt, which holds none of your
code, to lower the cost of later requests.

What the provider does with your code is governed by its own terms and privacy
policy, not by WhyCode. Read them before you send code you can't share:

- Anthropic: [privacy policy](https://www.anthropic.com/legal/privacy) and
  [commercial terms](https://www.anthropic.com/legal/commercial-terms)
- OpenRouter: [privacy policy](https://openrouter.ai/privacy)

Formatting happens on your machine. WhyCode passes code to the formatter
(Prettier, which is bundled, or Ruff, gofmt, rustfmt, CSharpier or
google-java-format from your PATH) on standard input and reads the result
back.

## What WhyCode stores

Nothing, unless you ask it to. WhyCode keeps no cache, no logs and no usage
data, and it never writes its own config. Two opt-in files exist, both written
only where you name them:

- `whycode check --save-plan <file>` saves the AI's comment plans and hashes
  (of the source, the request, the config and WhyCode itself). It contains
  the comments the AI proposed and the existing comments its suggestions
  quote, but no other source code. It never overwrites an existing file.
- `--review-state <file>` remembers reviewed files: their hashes, the pending
  suggestions for existing comments (with likely secrets masked, as in code
  sent to the AI) and the IDs of the ones you rejected. No source code.
  Delete the file to reset it.

Both are created readable only by your user account where the system
supports it. Results live in memory for one run and are
printed to your terminal.

It writes to your files only in these cases:

- `whycode fix` writes a file only after you accept its changes (or with
  `--yes`), and only if the file hasn't changed since WhyCode read it.
  `whycode check` never writes.
- In refactor mode with a `testCommand`, WhyCode puts the rewritten file in
  place while your test command runs, then writes the original back, whether
  the tests pass or fail. If you press Ctrl+C or close the terminal during the
  tests, WhyCode puts the original back before it exits; only a hard kill (such
  as `kill -9` or a power cut) can leave the rewritten version in the file. The
  test command comes from the project's `.whycoderc.json` and runs in a shell
  on your machine with your permissions. In a repository someone else wrote it
  is their command, so the refactor confirmation shows it exactly before
  anything runs.

## Front-ends

All front-ends run the same core engine, so file selection and secret masking
work the same way. What differs is where the code goes:

- The Claude Code plugin has no AI connection of its own. `whycode prompt`
  prints the request (masked as above) for Claude Code's model to read, so the
  code goes to the model Claude Code uses, under the terms of your Claude Code
  account. No API key is needed. `whycode preview` and `whycode write` send
  nothing anywhere.
- When using the VS Code extension with the Language Model API, code is sent to
  the model VS Code provides, under that provider's terms. With
  `ANTHROPIC_API_KEY` instead, code goes to Anthropic as described above.
- When using the GitHub Action, code is sent from GitHub's runners to the
  provider, with the API key read from a repository secret. Its suggestions are
  posted as review comments on the pull request, where anyone who can see the
  pull request can read them. Every file the pull request changed is sent
  (subject to the rules above), but suggestions are only posted for lines
  inside the pull request's diff. The action never pushes commits.

## Questions

Open an issue at
[github.com/Coreho/whycode](https://github.com/Coreho/whycode/issues).
