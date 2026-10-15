// Inserts AI-written comments as new lines above their target lines.
// Existing lines are never modified; only whole comment lines are added.
import type { CommentInsertion } from "../ai/comment-plan.js";
import { countLines } from "../text.js";

export interface InsertionResult {
  code: string;
  /** lineMap[oldLine - 1] is that line's 1-based number after insertion. */
  lineMap: number[];
  warnings: string[];
}

// Everything a JavaScript engine treats as a line break; a comment line must
// not contain any, or the rest of the text would become code.
const LINE_BREAKS = /\r\n|[\n\r\u2028\u2029]/;

export function applyInsertions(
  code: string,
  insertions: readonly CommentInsertion[],
  lineComment: string,
): InsertionResult {
  const lines = code.split("\n");
  const lineCount = countLines(code);
  const warnings: string[] = [];

  const inRange = insertions.filter((insertion) => {
    if (insertion.line <= lineCount) return true;
    warnings.push(
      `Dropped a comment for line ${insertion.line}: the file has only ${lineCount} lines.`,
    );
    return false;
  });

  const commentLinesByTarget = groupCommentLines(inRange, lines, lineComment);
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
    warnings,
  };
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

function toCommentLines(
  text: string,
  indent: string,
  lineComment: string,
): string[] {
  return text
    .split(LINE_BREAKS)
    .map((line) => withoutCommentMarker(line.trim(), lineComment))
    .map((line) =>
      line === ""
        ? `${indent}${lineComment}`
        : `${indent}${lineComment} ${line}`,
    );
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
