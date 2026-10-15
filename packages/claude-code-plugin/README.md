# WhyCode for Claude Code

A Claude Code plugin with one skill, `/whycode:cleanup`, that cleans up
AI-written code: it formats the files and adds comments that explain **what**
the code does and **why**, without changing its logic. It uses Claude Code's
own model, so no API key is needed.

Part of [WhyCode](../../README.md); see the main README for how verification
works and the configuration reference.

## Install

1. Install the WhyCode CLI, which does the real work (Node.js 22.12 or newer):

   ```sh
   npm install -g whycode
   ```

2. In Claude Code, add this repository as a plugin marketplace and install the
   plugin:

   ```
   /plugin marketplace add Coreho/whycode
   /plugin install whycode@whycode
   ```

   For local development, load it straight from a checkout instead:
   `claude --plugin-dir packages/claude-code-plugin`.

## Use

```
/whycode:cleanup src
/whycode:cleanup app.py utils.py --comment-level heavy
```

(`/cleanup` also works when no other plugin has a skill with that name.)

For each file Claude shows the diff WhyCode produced and asks whether to apply
it, then asks about any suggested rewrites of existing comments, which you can
accept one by one. Comment levels are `light` (default), `medium` and `heavy`;
`.whycoderc.json` settings such as `include` and `exclude` apply as in the CLI.

## How it works

Claude Code's model can't be called through an API, so the plugin turns the
model into WhyCode's AI step with three CLI commands:

1. `whycode prompt <file>` prints exactly the request WhyCode would send to a
   model: the system prompt, the reply schema and the file's numbered code.
   Collection applies the usual privacy rules, and likely secrets are masked.
2. Claude writes the JSON comment plan, and `whycode preview <file> --plan -`
   runs it through WhyCode's normal pipeline: validation, insertion,
   formatting and the logic-unchanged check. It prints the diff, the
   suggestions and a fingerprint, and writes nothing.
3. After you approve, `whycode write <file> --plan - --fingerprint <fp>`
   recomputes the result and writes it only if the fingerprint still matches,
   so what is written is exactly what you saw.

## Guarantees

The same as the CLI's:

- A diff is shown before anything is written. The skill pre-approves only
  `whycode prompt` and `whycode preview`, so Claude Code asks your permission
  before every `whycode write`.
- Verification is required: if Claude's comments would change the code's
  tokens, WhyCode discards them and offers only the formatting.
- Existing comments are never changed unless you accept a suggestion for
  them; suggestions are checked to change comment text only.
- Gitignored files and files that may hold secrets (`.env*`, `*.pem`, `*.key`
  and the like) are never read, and the skill tells Claude not to read them
  either.

Only safe mode is available in the plugin; refactor mode is CLI-only.

## License

MIT
