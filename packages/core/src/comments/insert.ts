// Inserts AI-written comments as new lines above their target lines.
// Existing lines are never modified; only whole comment lines are added.
import type { CommentInsertion } from "../ai/comment-plan.js";
import { countLines, withoutHiddenCharacters } from "../text.js";

export interface InsertionResult {
  code: string;
  /** lineMap[oldLine - 1] is that line's 1-based number after insertion. */
  lineMap: number[];
  /** How many of the insertions were placed; the rest were dropped with a warning. */
  inserted: number;
  warnings: string[];
}

// Everything a JavaScript or C# compiler treats as a line break (C# also ends
// a line at U+0085); a comment line must not contain any, or the rest of the
// text would become code.
export const LINE_BREAKS = /\r\n|[\n\r\u0085\u2028\u2029]/;

export function applyInsertions(
  code: string,
  insertions: readonly CommentInsertion[],
  lineComment: string,
): InsertionResult {
  const lines = code.split("\n");
  const lineCount = countLines(code);
  const warnings: string[] = [];

  const placeable = insertions
    .map((insertion) => ({
      ...insertion,
      line: aboveNextLineDirectives(insertion.line, lines),
    }))
    .filter((insertion) => {
      const problem =
        fillerProblem(insertion.text, lineComment) ??
        placementProblem(insertion.line, lines, lineCount, lineComment);
      if (problem === undefined) return true;
      warnings.push(
        `Dropped a comment for line ${insertion.line}: ${problem}.`,
      );
      return false;
    });

  const commentLinesByTarget = groupCommentLines(placeable, lines, lineComment);
  // Splice from the bottom up so earlier target line numbers stay valid.
  const targetsBottomUp = [...commentLinesByTarget.entries()].sort(
    ([a], [b]) => b - a,
  );
  for (const [targetLine, commentLines] of targetsBottomUp) {
    lines.splice(targetLine - 1, 0, ...commentLines);
  }

  return {
    code: lines.join("\n"),
    lineMap: buildLineMap(lineCount, commentLinesByTarget),
    inserted: placeable.length,
    warnings,
  };
}

/** Why a comment can't go above this 1-based line, or undefined if it can. */
function placementProblem(
  line: number,
  lines: readonly string[],
  lineCount: number,
  lineComment: string,
): string | undefined {
  if (line > lineCount) return `the file has only ${lineCount} lines`;
  // A trailing backslash continues the line (Python, shell, C macros, string
  // literals), so a comment line placed after it would become part of the code.
  if (lines[line - 2]?.endsWith("\\")) {
    return "the line before it ends with a backslash line continuation";
  }
  // A shebang only works on line 1. Rust's #![...] attributes aren't shebangs.
  if (line === 1 && isShebang(lines[0])) {
    return "line 1 is a shebang (#!), which must stay the first line";
  }
  // Python only reads an encoding declaration on line 1 or 2.
  const encodingLine =
    lines.slice(0, 2).findIndex((text) => ENCODING_DECLARATION.test(text)) + 1;
  if (encodingLine > 0 && line <= encodingLine) {
    return `line ${encodingLine} declares the file's encoding, which must stay within the first two lines`;
  }
  // The line is already explained by its own comment; another one would only
  // add clutter. Tool directives are the exception: an explanation of the code
  // belongs above them, never between a directive and the code it controls.
  const target = lines[line - 1] ?? "";
  if (isCommentLine(target, lineComment) && !isDirective(target)) {
    return `line ${line} is already a comment`;
  }
  return undefined;
}

// Directives that apply to the line right after them: a comment inserted in
// between would be what they cover, and the suppressed error would return.
const NEXT_LINE_DIRECTIVE =
  /^(\/\/|#|\/\*)\s*(@ts-expect-error|@ts-ignore|eslint-disable-next-line|prettier-ignore|biome-ignore|deno-lint-ignore|istanbul ignore next|c8 ignore next|noinspection|nolint|pylint:\s*disable-next|stylelint-disable-next-line)/;

// Other comments that instruct a tool about the code below them.
const DIRECTIVE =
  /^(\/\/|#)\s*(go:|\+build|eslint|type:|noqa|region|endregion|#?pragma)/;

function isDirective(line: string): boolean {
  const text = line.trimStart();
  return DIRECTIVE.test(text) || NEXT_LINE_DIRECTIVE.test(text);
}

/**
 * Moves a comment aimed just below a next-line directive (or a stack of
 * them) up above the directives, so they keep applying to their code.
 */
function aboveNextLineDirectives(
  line: number,
  lines: readonly string[],
): number {
  let target = line;
  while (
    target > 1 &&
    NEXT_LINE_DIRECTIVE.test((lines[target - 2] ?? "").trimStart())
  ) {
    target -= 1;
  }
  return target;
}

/** True for a line that starts with a comment (line or block style). */
function isCommentLine(line: string, lineComment: string): boolean {
  const text = line.trimStart();
  if (text.startsWith(lineComment)) return true;
  // C-family block comments and their continuation lines.
  return (
    lineComment === "//" && (text.startsWith("/*") || text.startsWith("* "))
  );
}

// Words a model sometimes returns instead of an explanation.
const FILLER =
  /^(placeholder|todo|tbd|fixme|xxx|n\/?a|none|null|empty|comment|note|\.\.\.|-+)$/i;

/** Why a comment's text is filler that explains nothing, or undefined. */
function fillerProblem(text: string, lineComment: string): string | undefined {
  const comment = withoutCommentMarker(cleanCommentText(text), lineComment);
  if (comment === "") return "its text is empty";
  // "TODO:", "Placeholder." and "..." are filler too.
  const words = comment.replace(/[.:;!]+$/, "").trim();
  if (words === "" || FILLER.test(words)) {
    return `its text "${comment}" explains nothing`;
  }
  return undefined;
}

// PEP 263's pattern, e.g. "# -*- coding: latin-1 -*-".
const ENCODING_DECLARATION = /^[ \t\f]*#.*?coding[:=][ \t]*[-\w.]+/;

function isShebang(line: string | undefined): boolean {
  return line !== undefined && line.startsWith("#!") && !line.startsWith("#![");
}

/** Comment lines to insert above each target line, in the AI's order. */
function groupCommentLines(
  insertions: readonly CommentInsertion[],
  lines: readonly string[],
  lineComment: string,
): Map<number, string[]> {
  const byTarget = new Map<number, string[]>();
  for (const insertion of insertions) {
    const indent = leadingWhitespace(lines[insertion.line - 1] ?? "");
    const existing = byTarget.get(insertion.line) ?? [];
    existing.push(...toCommentLines(insertion.text, indent, lineComment));
    byTarget.set(insertion.line, existing);
  }
  return byTarget;
}

function buildLineMap(
  lineCount: number,
  commentLinesByTarget: Map<number, string[]>,
): number[] {
  const lineMap: number[] = [];
  let shift = 0;
  for (let line = 1; line <= lineCount; line++) {
    shift += commentLinesByTarget.get(line)?.length ?? 0;
    lineMap.push(line + shift);
  }
  return lineMap;
}

/** Turns AI-written text into comment lines with the given marker and indent. */
export function toCommentLines(
  text: string,
  indent: string,
  lineComment: string,
): string[] {
  return text
    .split(LINE_BREAKS)
    .map((line) => withoutCommentMarker(cleanCommentText(line), lineComment))
    .map((line) =>
      line === ""
        ? `${indent}${lineComment}`
        : `${indent}${lineComment} ${line}`,
    );
}

/**
 * Removes hidden characters and trailing backslashes: in C and C++ a
 * backslash at the end of a comment line continues the comment onto the
 * next line, which would turn that line of code into a comment.
 */
export function cleanCommentText(text: string): string {
  return withoutHiddenCharacters(text).trim().replace(/\\+$/, "").trimEnd();
}

/** Drops a marker the AI included despite instructions, avoiding "# # text". */
function withoutCommentMarker(line: string, lineComment: string): string {
  return line.startsWith(lineComment)
    ? line.slice(lineComment.length).trimStart()
    : line;
}

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}
