---
name: cleanup
description: Clean up AI-written code with WhyCode, using Claude Code's own model. Adds comments that explain what the code does and why, checked so they can't change the code, and formats with the project's own formatter; shows each file's diff and writes only what the user approves.
argument-hint: "[paths...] [--comment-level light|medium|heavy]"
disable-model-invocation: true
allowed-tools: Bash(whycode --version) Bash(whycode prompt:*) Bash(whycode preview:*)
---

# WhyCode cleanup

Clean up these paths with WhyCode: $ARGUMENTS

WhyCode formats code with the project's own formatter and inserts explanatory
comments, then checks that the comments left the code's tokens unchanged. In this skill **you are
WhyCode's AI**: WhyCode prints the exact request it would send to a model, you
write the JSON reply, and WhyCode does everything else (privacy rules,
formatting, insertion, verification, writing). No API key is needed.

## Rules you must follow

1. **Never change code yourself.** Do not use Edit, Write or shell commands on
   the files being cleaned up. Files change only through `whycode write`.
2. **Only see code through `whycode prompt`.** Do not open, read, grep or quote
   files WhyCode skipped (gitignored files, `.env*`, keys and other secret
   files), and do not read the target files any other way.
3. **Nothing is written without the user's approval.** Run `whycode write` for a
   file only after the user approved that file's diff in this conversation, and
   pass only the suggestion numbers the user accepted.
4. **Your reply is a comment plan, never code.** Follow WhyCode's system prompt
   exactly and reply with JSON matching its schema. Do not rewrite, reformat or
   "fix" code in the plan.
5. Never pass `--yes`, `--refactor` or any other flag not shown here.

## Steps

1. Run `whycode --version`. If the command is not found, tell the user to
   install the WhyCode CLI (`npm install -g whycode`, which needs Node.js 22.12
   or newer) and stop.
2. Work out the paths and the optional `--comment-level light|medium|heavy`
   from the arguments above. If no paths were given, ask the user which files
   or folders to clean up; never default to the whole repository.
3. Run `whycode prompt <paths...> --list` (add `--comment-level <level>` if
   given). Tell the user how many files WhyCode will process, and list the
   skipped paths with WhyCode's reasons. If the command fails, show its error
   and stop. If there are more than 10 files, confirm with the user before
   starting, and offer to stop after every 10.
4. For each listed file, one at a time:
   1. Run `whycode prompt <file>` (with the same `--comment-level`). It prints
      the system prompt, the reply schema and the file's numbered code.
   2. Write the comment plan: do exactly what the system prompt asks for that
      code, using its line numbers. The plan is JSON only.
   3. Preview it, passing the plan on standard input with a quoted heredoc:

      ```sh
      whycode preview <file> --plan - <<'WHYCODE_PLAN'
      {"insertions":[...],"existingCommentSuggestions":[...]}
      WHYCODE_PLAN
      ```

      The closing `WHYCODE_PLAN` must be on its own line with nothing before
      it. If WhyCode reports an invalid plan, fix the JSON and preview again (at
      most twice), then report the file as failed and move on. If it prints
      `No changes`, move on.

   4. Show the user the diff exactly as WhyCode printed it, in a `diff` code
      block, followed by its notes. If verification failed, say plainly that
      WhyCode discarded the comments and only the formatting is offered.
      Show each suggested rewrite of an existing comment with its number,
      the original, the suggestion and the reason.
   5. Ask with the AskUserQuestion tool whether to apply this file's changes
      (Apply / Skip). If there are suggested rewrites of existing comments,
      and the user chose Apply or the file had no other changes, ask about the
      suggestions individually: one multi-select question whose options are the
      suggestions (at most 4 per question; ask more questions if needed).
      Unselected suggestions are not applied.
   6. If the user approved, write it with the identical plan and the
      fingerprint from the preview:

      ```sh
      whycode write <file> --plan - --fingerprint <fingerprint> --accept-suggestions <numbers> <<'WHYCODE_PLAN'
      <the same plan JSON>
      WHYCODE_PLAN
      ```

      Leave out `--accept-suggestions` when none were accepted. Claude Code may
      ask the user to allow this command; that is the final confirmation. If
      WhyCode says the file changed since the preview, preview it again and ask
      again.
5. Finish with a short summary: files written (and suggestions applied), files
   the user skipped, files with no changes, files that failed, and the paths
   WhyCode never read.
