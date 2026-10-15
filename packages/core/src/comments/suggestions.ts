// Applies the AI's suggested rewrites of existing comments once a person has
// accepted them. A suggestion may only change comment text: for languages
// with full support the token stream must stay identical, and for
// comments-only languages the change must stay inside one line comment.
import type { ExistingCommentSuggestion } from "../ai/comment-plan.js";
import type { LanguageAdapter } from "../languages/adapter.js";
import { findAdapterForPath } from "../languages/adapter.js";
import { findCommentOnlyLanguage } from "../languages/fallback.js";
import { detectLineEnding, restoreLineEnding, toLf } from "../text.js";
import { compareTokenStreams } from "../verify.js";

export interface SuggestionsResult {
  /** The code with every applicable suggestion applied, original line endings. */
  code: string;
  applied: ExistingCommentSuggestion[];
  notApplied: { suggestion: ExistingCommentSuggestion; reason: string }[];
}

type Replacement = { ok: true; code: string } | { ok: false; reason: string };

/** Line breaks in any supported language, as in comments/insert.ts. */
const LINE_BREAK = /[\n\r\u0085\u2028\u2029]/;

export async function applyCommentSuggestions(
  path: string,
  code: string,
  suggestions: readonly ExistingCommentSuggestion[],
  adapters: readonly LanguageAdapter[],
): Promise<SuggestionsResult> {
  const adapter = findAdapterForPath(path, adapters);
  const lineComment =
    adapter?.lineComment ?? findCommentOnlyLanguage(path)?.lineComment;
  const result: SuggestionsResult = { code, applied: [], notApplied: [] };
  if (lineComment === undefined) {
    result.notApplied = suggestions.map((suggestion) => ({
      suggestion,
      reason: "unsupported file type",
    }));
    return result;
  }

  let current = toLf(code);
  const isSafe = adapter
    ? await tokensUnchangedCheck(adapter, current)
    : lineCommentCheck(lineComment);
  // Bottom-up, so a suggestion that adds lines doesn't shift those above it.
  const bottomUp = [...suggestions].sort((a, b) => b.line - a.line);
  for (const suggestion of bottomUp) {
    const replaced = replaceComment(current, suggestion, lineComment);
    const problem = replaced.ok
      ? await isSafe(current, replaced.code, suggestion)
      : replaced.reason;
    if (replaced.ok && problem === undefined) {
      current = replaced.code;
      result.applied.push(suggestion);
    } else {
      result.notApplied.push({ suggestion, reason: problem ?? "" });
    }
  }
  result.code = restoreLineEnding(current, detectLineEnding(code));
  return result;
}

/** Says why a rewrite from `before` to `after` is unsafe, or undefined if it is safe. */
type SafetyCheck = (
  before: string,
  after: string,
  suggestion: ExistingCommentSuggestion,
) => Promise<string | undefined>;

/** Replaces the original comment text, which must start on the suggestion's line. */
function replaceComment(
  code: string,
  suggestion: ExistingCommentSuggestion,
  lineComment: string,
): Replacement {
  const original = suggestion.original.trim();
  if (original === "") {
    return { ok: false, reason: "it doesn't say which comment to replace" };
  }
  const lineStart = startOfLine(code, suggestion.line);
  if (lineStart === undefined) {
    return {
      ok: false,
      reason: `line ${suggestion.line} is past the end of the file`,
    };
  }
  const lineEnd = endOfLine(code, lineStart);
  const index = code.indexOf(original, lineStart);
  if (index === -1 || index > lineEnd) {
    return {
      ok: false,
      reason: `line ${suggestion.line} no longer holds the comment it would replace`,
    };
  }
  const indent = /^[ \t]*/.exec(code.slice(lineStart, lineEnd))?.[0] ?? "";
  const suggested = indentFollowingLines(
    matchMarker(original, suggestion.suggested.trim(), lineComment),
    indent,
  );
  return {
    ok: true,
    code:
      code.slice(0, index) + suggested + code.slice(index + original.length),
  };
}

/** Drops a comment marker the AI added that the original text didn't include. */
function matchMarker(
  original: string,
  suggested: string,
  lineComment: string,
): string {
  return !original.startsWith(lineComment) && suggested.startsWith(lineComment)
    ? suggested.slice(lineComment.length).trimStart()
    : suggested;
}

/** Gives the second and later lines of a multi-line comment the first line's indent. */
function indentFollowingLines(text: string, indent: string): string {
  const [first = "", ...rest] = text.split("\n");
  const indented = rest.map((line) => {
    const trimmed = line.trimStart();
    // Block comment continuation lines (" * text") sit one column in.
    return trimmed.startsWith("*")
      ? `${indent} ${trimmed}`
      : `${indent}${trimmed}`;
  });
  return [first, ...indented].join("\n");
}

/** Full support: comments aren't tokens, so the token stream must not change. */
async function tokensUnchangedCheck(
  adapter: LanguageAdapter,
  code: string,
): Promise<SafetyCheck> {
  const tokensBefore = await adapter.tokens(code);
  return async (_before, after) => {
    const comparison = compareTokenStreams(
      tokensBefore,
      await adapter.tokens(after),
    );
    return comparison.equal
      ? undefined
      : "it would change code, not only a comment (a docstring, for example, is code)";
  };
}

/**
 * Without a parser, the only safe change is one inside a line that is a
 * comment from its first character: no string or code can precede it.
 */
function lineCommentCheck(lineComment: string): SafetyCheck {
  return (before, _after, suggestion) => {
    const lineStart = startOfLine(before, suggestion.line) ?? 0;
    const line = before.slice(lineStart, endOfLine(before, lineStart));
    const confined =
      line.trimStart().startsWith(lineComment) &&
      !LINE_BREAK.test(suggestion.original.trim()) &&
      !LINE_BREAK.test(suggestion.suggested.trim());
    return Promise.resolve(
      confined
        ? undefined
        : "without full support for this language, only a single-line comment can be rewritten",
    );
  };
}

/** Offset of the first character of a 1-based line, or undefined past the end. */
function startOfLine(code: string, line: number): number | undefined {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const newline = code.indexOf("\n", offset);
    if (newline === -1) return undefined;
    offset = newline + 1;
  }
  return offset < code.length ? offset : undefined;
}

function endOfLine(code: string, lineStart: number): number {
  const newline = code.indexOf("\n", lineStart);
  return newline === -1 ? code.length : newline;
}
