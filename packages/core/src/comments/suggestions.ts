// Applies the AI's suggested rewrites of existing comments once a person has
// accepted them. A suggestion may only replace a comment with a comment, in
// one of three shapes:
// - whole comment lines (lines that start with the line-comment marker) are
//   replaced by new comment lines, built exactly like inserted comments;
// - a line comment that ends a line of code is replaced on that line;
// - a /* block comment */ is replaced by one block comment; next to code it
//   keeps its line-break structure (in JavaScript a line break inside a
//   block comment can end a statement).
// For languages with full support the token stream must also stay identical.
// Languages without it only get whole comment lines. Lines keep their own
// line endings, and the text is returned unchanged if nothing applies.
import type { ExistingCommentSuggestion } from "../ai/comment-plan.js";
import type { LanguageAdapter } from "../languages/adapter.js";
import { findAdapterForPath } from "../languages/adapter.js";
import { findCommentOnlyLanguage } from "../languages/fallback.js";
import { compareTokenStreams } from "../verify.js";
import { cleanCommentText, LINE_BREAKS, toCommentLines } from "./insert.js";

export interface SuggestionsResult {
  /** The code with every applicable suggestion applied. */
  code: string;
  applied: ExistingCommentSuggestion[];
  notApplied: { suggestion: ExistingCommentSuggestion; reason: string }[];
}

interface Line {
  text: string;
  /** "\r\n", "\n", or "" for a last line without a line break. */
  eol: string;
}

type Replacement =
  | { ok: true; start: number; end: number; lines: string[] }
  | { ok: false; reason: string };

interface CommentSyntax {
  lineComment: string;
  /** Only languages with a parser can have code-line and block comments checked. */
  fullSupport: boolean;
}

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const BLOCK_START = "/*";
const BLOCK_END = "*/";

export async function applyCommentSuggestions(
  path: string,
  code: string,
  suggestions: readonly ExistingCommentSuggestion[],
  adapters: readonly LanguageAdapter[],
): Promise<SuggestionsResult> {
  const result: SuggestionsResult = { code, applied: [], notApplied: [] };
  const adapter = findAdapterForPath(path, adapters);
  const lineComment =
    adapter?.lineComment ?? findCommentOnlyLanguage(path)?.lineComment;
  if (lineComment === undefined) {
    result.notApplied = suggestions.map((suggestion) => ({
      suggestion,
      reason: "unsupported file type",
    }));
    return result;
  }
  const syntax = { lineComment, fullSupport: adapter !== undefined };
  const hasBom = code.startsWith(BYTE_ORDER_MARK);
  let lines = splitLines(hasBom ? code.slice(1) : code);
  const tokensBefore = adapter ? await adapter.tokens(joinLf(lines)) : [];

  // Bottom-up, so a suggestion that adds lines doesn't shift those above it.
  const bottomUp = [...suggestions].sort((a, b) => b.line - a.line);
  for (const suggestion of bottomUp) {
    const replacement = planReplacement(lines, suggestion, syntax);
    if (!replacement.ok) {
      result.notApplied.push({ suggestion, reason: replacement.reason });
      continue;
    }
    const candidate = replaceLines(lines, replacement);
    if (adapter) {
      const comparison = compareTokenStreams(
        tokensBefore,
        await adapter.tokens(joinLf(candidate)),
      );
      if (!comparison.equal) {
        result.notApplied.push({
          suggestion,
          reason:
            "it would change code, not only a comment (a docstring, for example, is code)",
        });
        continue;
      }
    }
    lines = candidate;
    result.applied.push(suggestion);
  }
  if (result.applied.length > 0) {
    result.code = (hasBom ? BYTE_ORDER_MARK : "") + joinLines(lines);
  }
  return result;
}

/** Works out which lines the suggestion replaces, and with what. */
function planReplacement(
  lines: readonly Line[],
  suggestion: ExistingCommentSuggestion,
  syntax: CommentSyntax,
): Replacement {
  if (suggestion.original.trim() === "") {
    return { ok: false, reason: "it doesn't say which comment to replace" };
  }
  if (lines[suggestion.line - 1] === undefined) {
    return {
      ok: false,
      reason: `line ${suggestion.line} is past the end of the file`,
    };
  }
  const shapes = syntax.fullSupport
    ? [wholeCommentLines, trailingComment, blockComment]
    : [wholeCommentLines];
  for (const shape of shapes) {
    const replacement = shape(lines, suggestion, syntax);
    if (replacement !== undefined) return replacement;
  }
  return {
    ok: false,
    reason: syntax.fullSupport
      ? `line ${suggestion.line} no longer holds the comment it would replace`
      : "without full support for this language, only whole comment lines can be rewritten",
  };
}

/** Lines that are comments from their first character, replaced line for line. */
function wholeCommentLines(
  lines: readonly Line[],
  suggestion: ExistingCommentSuggestion,
  { lineComment }: CommentSyntax,
): Replacement | undefined {
  const originalLines = suggestion.original.trim().split(LINE_BREAKS);
  const start = suggestion.line - 1;
  const matches = originalLines.every((original, offset) => {
    const text = lines[start + offset]?.text.trim();
    return (
      text !== undefined &&
      text.startsWith(lineComment) &&
      withoutMarker(text, lineComment) ===
        withoutMarker(original.trim(), lineComment)
    );
  });
  if (!matches) return undefined;
  const indent = leadingWhitespace(lines[start]?.text ?? "");
  const newLines = toCommentLines(suggestion.suggested, indent, lineComment);
  return {
    ok: true,
    start,
    end: start + originalLines.length,
    lines: newLines,
  };
}

/** A line comment after code on the same line: `x = 1  # old` -> `x = 1  # new`. */
function trailingComment(
  lines: readonly Line[],
  suggestion: ExistingCommentSuggestion,
  { lineComment }: CommentSyntax,
): Replacement | undefined {
  const original = suggestion.original.trim();
  const text = lines[suggestion.line - 1]?.text ?? "";
  if (LINE_BREAKS.test(original)) return undefined;
  const found = text.lastIndexOf(original);
  if (found === -1 || text.slice(found + original.length).trim() !== "") {
    return undefined;
  }
  // The comment starts at its marker, which the AI may have left out.
  const markerAt = original.startsWith(lineComment)
    ? found
    : text.slice(0, found).trimEnd().length - lineComment.length;
  if (markerAt < 1 || !text.startsWith(lineComment, markerAt)) return undefined;
  if (text.slice(0, markerAt).trim() === "") return undefined;
  const newText = singleLine(
    withoutMarker(suggestion.suggested.trim(), lineComment),
  );
  if (newText === undefined) {
    return { ok: false, reason: "a comment after code must stay on one line" };
  }
  const newLine = `${text.slice(0, markerAt)}${lineComment} ${newText}`;
  return {
    ok: true,
    start: suggestion.line - 1,
    end: suggestion.line,
    lines: [newLine],
  };
}

/** One block comment that starts on the suggestion's line. */
function blockComment(
  lines: readonly Line[],
  suggestion: ExistingCommentSuggestion,
): Replacement | undefined {
  const original = suggestion.original.trim();
  const suggested = suggestion.suggested.trim();
  if (!isBlockComment(original)) return undefined;
  const start = suggestion.line - 1;
  const end = start + original.split("\n").length;
  const region = lines
    .slice(start, end)
    .map((line) => line.text)
    .join("\n");
  const found = region.indexOf(original);
  if (found === -1 || found > (lines[start]?.text.length ?? 0)) {
    return undefined;
  }
  if (!isBlockComment(suggested) || hasOtherLineBreaks(suggested)) {
    return {
      ok: false,
      reason: "a block comment can only be replaced by one block comment",
    };
  }
  // Next to code, a line break inside the comment can end a JavaScript
  // statement; a comment on lines of its own can take any shape.
  const standsAlone =
    region.slice(0, found).trim() === "" &&
    region.slice(found + original.length).trim() === "";
  if (!standsAlone && original.includes("\n") !== suggested.includes("\n")) {
    return {
      ok: false,
      reason:
        "next to code, the rewrite can't add or remove line breaks inside a block comment",
    };
  }
  const indent = leadingWhitespace(lines[start]?.text ?? "");
  const replaced =
    region.slice(0, found) +
    indentFollowingLines(suggested, indent) +
    region.slice(found + original.length);
  return { ok: true, start, end, lines: replaced.split("\n") };
}

/** Starts with the block opener, ends with the closer, nothing else inside. */
function isBlockComment(text: string): boolean {
  if (text.length < BLOCK_START.length + BLOCK_END.length) return false;
  if (!text.startsWith(BLOCK_START) || !text.endsWith(BLOCK_END)) return false;
  const inside = text.slice(BLOCK_START.length, -BLOCK_END.length);
  return !inside.includes(BLOCK_END) && !inside.includes(BLOCK_START);
}

/** Line breaks other than LF (CR, NEL, LS, PS), which some compilers honor. */
function hasOtherLineBreaks(text: string): boolean {
  return text.split("\n").some((part) => LINE_BREAKS.test(part));
}

/** Gives the second and later lines of a block comment the first line's indent. */
function indentFollowingLines(text: string, indent: string): string {
  const [first = "", ...rest] = text.split("\n");
  const indented = rest.map((line) => {
    const trimmed = line.trimStart();
    // Continuation lines (" * text") sit one column in.
    return trimmed.startsWith("*")
      ? `${indent} ${trimmed}`
      : `${indent}${trimmed}`;
  });
  return [first, ...indented].join("\n");
}

/** The suggestion as one clean line, or undefined if it has several. */
function singleLine(text: string): string | undefined {
  const parts = text.split(LINE_BREAKS).filter((part) => part.trim() !== "");
  if (parts.length !== 1 || parts[0] === undefined) return undefined;
  const cleaned = cleanCommentText(parts[0]);
  return cleaned === "" ? undefined : cleaned;
}

function withoutMarker(text: string, lineComment: string): string {
  return text.startsWith(lineComment)
    ? text.slice(lineComment.length).trim()
    : text.trim();
}

function leadingWhitespace(text: string): string {
  return /^[ \t]*/.exec(text)?.[0] ?? "";
}

/** Splits text into lines, remembering each line's own line ending. */
function splitLines(code: string): Line[] {
  if (code === "") return [];
  const parts = code.split("\n");
  const lines = parts.map((part, index): Line => {
    if (index === parts.length - 1) return { text: part, eol: "" };
    return part.endsWith("\r")
      ? { text: part.slice(0, -1), eol: "\r\n" }
      : { text: part, eol: "\n" };
  });
  // A trailing line break doesn't start another line.
  if (lines.at(-1)?.text === "") lines.pop();
  return lines;
}

function joinLines(lines: readonly Line[]): string {
  return lines.map((line) => line.text + line.eol).join("");
}

/** The code with LF line breaks, for tokenizing. */
function joinLf(lines: readonly Line[]): string {
  return lines.map((line) => `${line.text}\n`).join("");
}

/**
 * Replaces lines start..end-1. New lines take the replaced lines' line
 * ending, and the last keeps the last replaced line's (possibly none).
 */
function replaceLines(
  lines: readonly Line[],
  replacement: Extract<Replacement, { ok: true }>,
): Line[] {
  const replaced = lines.slice(replacement.start, replacement.end);
  const lastEol = replaced.at(-1)?.eol ?? "\n";
  const innerEol = replaced[0]?.eol || "\n";
  const newLines = replacement.lines.map((text, index): Line => ({
    text,
    eol: index === replacement.lines.length - 1 ? lastEol : innerEol,
  }));
  return [
    ...lines.slice(0, replacement.start),
    ...newLines,
    ...lines.slice(replacement.end),
  ];
}
