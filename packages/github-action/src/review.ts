// Translates core previews into GitHub review comments; never applies them to disk.
import {
  applyCommentSuggestions,
  createLineSuggestions,
  fileVerdict,
  unifiedRightRanges,
} from "@whycode/core";
import type {
  FileResult,
  LanguageAdapter,
  LineSuggestion,
} from "@whycode/core";

export interface ReviewComment {
  path: string;
  body: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
}

export interface FileReview {
  comments: ReviewComment[];
  notes: string[];
}

/** Fence syntax supplies one separator newline, never a replacement blank line. */
export function suggestionBody(replacement: string): string {
  const longest = Math.max(
    2,
    ...[...replacement.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(longest + 1);
  const content = replacement.replace(/\r?\n$/, "");
  return `${fence}suggestion\n${content}${replacement === "" ? "" : "\n"}${fence}`;
}

function reviewComment(path: string, edit: LineSuggestion): ReviewComment {
  return {
    path,
    body: suggestionBody(edit.replacement),
    line: edit.endLine,
    side: "RIGHT",
    ...(edit.startLine < edit.endLine
      ? { start_line: edit.startLine, start_side: "RIGHT" as const }
      : {}),
  };
}

export async function reviewFile(
  result: FileResult,
  patch: string | undefined,
  adapters: readonly LanguageAdapter[],
): Promise<FileReview> {
  // The same verdict wording as every other front-end leads the notes; a
  // file with nothing to say adds none, so a clean PR gets no review.
  const verdict = fileVerdict(result);
  const quiet =
    verdict.kind === "unchanged" && result.commentSuggestions.length === 0;
  const review: FileReview = {
    comments: [],
    notes: quiet ? [] : [verdict.text],
  };
  if (result.verification === "failed") {
    review.notes.push("no suggestions posted");
    return review;
  }
  if (result.status === "skipped") return review;
  const ranges = unifiedRightRanges(patch);
  const mapped = createLineSuggestions(
    result.originalCode,
    result.outputCode,
    ranges,
  );
  const edits = [...mapped.suggestions];
  const outside = mapped.withheld.filter(
    (edit) => edit.reason === "outside allowed ranges",
  ).length;
  if (outside) review.notes.push(`${outside} change(s) outside the PR diff`);
  if (mapped.withheld.length > outside)
    review.notes.push(
      `${mapped.withheld.length - outside} change(s) cannot preserve the final newline in a review suggestion`,
    );
  let withheld = 0;
  for (const suggestion of result.commentSuggestions) {
    const originalLine = mapped.originalLines.get(suggestion.line);
    if (originalLine === undefined) {
      withheld++;
      continue;
    }
    // Recheck each proposed comment rewrite independently against the PR head.
    const applied = await applyCommentSuggestions(
      result.path,
      result.originalCode,
      [{ ...suggestion, line: originalLine }],
      adapters,
    );
    const candidate = createLineSuggestions(
      result.originalCode,
      applied.code,
      ranges,
    );
    const overlaps = candidate.suggestions.some((edit) =>
      edits.some(
        (other) =>
          edit.startLine <= other.endLine && edit.endLine >= other.startLine,
      ),
    );
    if (applied.notApplied.length || candidate.withheld.length || overlaps)
      withheld++;
    else edits.push(...candidate.suggestions);
  }
  if (withheld)
    review.notes.push(
      `${withheld} existing-comment suggestion(s) outside the diff, overlapping another suggestion, or not safely mappable to the PR head`,
    );
  review.comments = edits.map((edit) => reviewComment(result.path, edit));
  review.notes.push(...result.warnings);
  return review;
}
