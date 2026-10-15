// The one-line outcome of a processed file, worded the same in every
// front-end. It claims only what WhyCode checks: that inserting comments
// left the code's tokens unchanged, never that "nothing changed", since
// formatting and comments do change the file.
import type { FileResult } from "./pipeline.js";

export type VerdictKind =
  /** Nothing to write (there may still be suggestions for existing comments). */
  | "unchanged"
  /** Comments and/or formatting, with comment insertion verified. */
  | "verified"
  /** Verification failed, so the AI's comments were thrown away. */
  | "discarded"
  /** Comments added in a language WhyCode can't verify. */
  | "unverified"
  /** Refactor mode: the AI rewrote the code, so logic may change. */
  | "refactored"
  /** The file couldn't be processed. */
  | "failed";

export interface FileVerdict {
  kind: VerdictKind;
  /** A short sentence fragment, e.g. "2 comments added; ...". */
  text: string;
}

export function fileVerdict(result: FileResult): FileVerdict {
  if (result.status === "skipped") {
    return {
      kind: "failed",
      text: `not processed: ${result.skipReason ?? "unknown error"}`,
    };
  }
  const base = mainVerdict(result);
  const suggestions = result.commentSuggestions.length;
  if (suggestions === 0) return base;
  return {
    ...base,
    text: `${base.text}; ${plural(suggestions, "suggested rewrite")} of existing comments to review`,
  };
}

function mainVerdict(result: FileResult): FileVerdict {
  const changed = result.status === "changed";
  if (result.mode === "refactor") {
    return changed
      ? { kind: "refactored", text: "rewritten by the AI, so logic may change" }
      : { kind: "unchanged", text: "nothing to change" };
  }
  if (result.verification === "failed") {
    return {
      kind: "discarded",
      text: changed
        ? "comments discarded because verification failed; only formatting is offered"
        : "comments discarded because verification failed; nothing else to change",
    };
  }
  if (!changed) return { kind: "unchanged", text: "nothing to change" };
  const comments = plural(result.commentsAdded, "comment");
  if (result.mode === "comments-only") {
    return {
      kind: "unverified",
      text: `${comments} added without verification (no full support for ${result.languageId ?? "this language"})`,
    };
  }
  return {
    kind: "verified",
    text:
      result.commentsAdded === 0
        ? "formatting only (no comments were needed)"
        : `${comments} added; comment insertion preserved the checked code tokens`,
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
