// Scripted AI replies that choose their target lines from the numbered code
// the pipeline sends ("12| text"). Tests can aim comments at a construct
// without hard-coding line numbers, which move when the formatter runs.
import type { CommentInsertion } from "../ai/comment-plan.js";
import type { AIRequest } from "../ai/provider.js";
import { commentPlanReply } from "./fake-provider.js";

export interface NumberedLine {
  number: number;
  text: string;
}

/** The numbered code lines in a comment-pass request. */
export function numberedLines(request: AIRequest): NumberedLine[] {
  return request.user.split("\n").flatMap((line) => {
    const match = /^(\d+)\| (.*)$/.exec(line);
    return match ? [{ number: Number(match[1]), text: match[2] ?? "" }] : [];
  });
}

const above = (line: number, text: string): CommentInsertion => ({
  line,
  position: "above",
  text,
});

/**
 * Replies with one comment above the first line matching `pattern`. Throws
 * when nothing matches, so a test can't pass by aiming at a missing line.
 */
export function commentAboveFirstMatch(pattern: RegExp, text: string) {
  return (request: AIRequest): string => {
    const target = numberedLines(request).find((line) =>
      pattern.test(line.text),
    );
    if (target === undefined) {
      throw new Error(`No line matches ${String(pattern)}`);
    }
    return commentPlanReply({ insertions: [above(target.number, text)] });
  };
}

/** Replies with one comment above every line matching `pattern`. */
export function commentAboveEveryMatch(pattern: RegExp, text: string) {
  return (request: AIRequest): string => {
    const insertions = numberedLines(request)
      .filter((line) => pattern.test(line.text))
      .map((line) => above(line.number, text));
    return commentPlanReply({ insertions });
  };
}
