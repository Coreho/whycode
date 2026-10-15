// Maps exact text changes to independent whole-line replacements for constrained
// previews (review diffs or editor selections). No files are read or written.
import { diffArrays, parsePatch } from "diff";

export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface LineSuggestion extends LineRange {
  /** Exact replacement, including the final line ending; empty means deletion. */
  replacement: string;
}

export interface LineSuggestions {
  suggestions: LineSuggestion[];
  withheld: (LineRange & { reason: string })[];
  /** Unchanged output lines mapped back to the original, before formatting/insertion. */
  originalLines: Map<number, number>;
}

/** A range must fit within one hunk: joining separate hunks isn't reviewable. */
export function containsLineRange(
  ranges: readonly LineRange[],
  target: LineRange,
): boolean {
  return ranges.some(
    (range) =>
      range.startLine <= target.startLine && range.endLine >= target.endLine,
  );
}

/** Reads only complete unified hunks, failing closed for absent/truncated patches. */
export function unifiedRightRanges(patch: string | undefined): LineRange[] {
  if (!patch) return [];
  try {
    return parsePatch(patch).flatMap((file) =>
      file.hunks
        .filter((hunk) => hunk.newLines > 0)
        .map((hunk) => ({
          startLine: hunk.newStart,
          endLine: hunk.newStart + hunk.newLines - 1,
        })),
    );
  } catch {
    return [];
  }
}

/** Keeps line endings as part of each token, avoiding split's phantom EOF line. */
function lines(code: string): string[] {
  return code.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function createLineSuggestions(
  before: string,
  after: string,
  ranges: readonly LineRange[],
): LineSuggestions {
  const original = lines(before);
  const result: LineSuggestions = {
    suggestions: [],
    withheld: [],
    originalLines: new Map(),
  };
  const edits: LineSuggestion[] = [];
  let oldLine = 1;
  let newLine = 1;
  let pending: LineSuggestion | undefined;
  const flush = () => {
    if (!pending) return;
    const edit = anchorInsertion(pending, original);
    const previous = edits.at(-1);
    // An insertion before the last line and one at EOF share that anchor.
    if (previous && previous.endLine === edit.startLine) {
      const anchor = original[edit.startLine - 1] ?? "";
      previous.replacement =
        previous.replacement.slice(
          0,
          previous.replacement.length - anchor.length,
        ) + edit.replacement;
      previous.endLine = edit.endLine;
    } else edits.push(edit);
    pending = undefined;
  };
  for (const change of diffArrays(original, lines(after))) {
    if (!change.added && !change.removed) {
      flush();
      for (let offset = 0; offset < change.value.length; offset++) {
        result.originalLines.set(newLine + offset, oldLine + offset);
      }
      oldLine += change.value.length;
      newLine += change.value.length;
    } else {
      pending ??= { startLine: oldLine, endLine: oldLine - 1, replacement: "" };
      if (change.removed) {
        oldLine += change.value.length;
        pending.endLine = oldLine - 1;
      } else {
        pending.replacement += change.value.join("");
        newLine += change.value.length;
      }
    }
  }
  flush();
  for (const edit of edits) {
    const reason = !containsLineRange(ranges, edit)
      ? "outside allowed ranges"
      : !representable(edit, original)
        ? "empty file or final newline cannot be represented safely"
        : undefined;
    if (reason)
      result.withheld.push({
        startLine: edit.startLine,
        endLine: edit.endLine,
        reason,
      });
    else result.suggestions.push(edit);
  }
  return result;
}

/** Insertions need a real line to select; prefer the following line. */
function anchorInsertion(
  edit: LineSuggestion,
  original: readonly string[],
): LineSuggestion {
  if (edit.endLine >= edit.startLine) return edit;
  const following = original[edit.startLine - 1];
  if (following !== undefined) {
    return {
      ...edit,
      endLine: edit.startLine,
      replacement: edit.replacement + following,
    };
  }
  const previous = original[edit.startLine - 2];
  return previous === undefined
    ? edit
    : {
        startLine: edit.startLine - 1,
        endLine: edit.startLine - 1,
        replacement: previous + edit.replacement,
      };
}

/** Whole-line review UIs can't encode a missing final newline reliably. */
function representable(
  edit: LineSuggestion,
  original: readonly string[],
): boolean {
  const last = original[edit.endLine - 1];
  return (
    last !== undefined &&
    last.endsWith("\n") &&
    (edit.replacement === "" || edit.replacement.endsWith("\n"))
  );
}
