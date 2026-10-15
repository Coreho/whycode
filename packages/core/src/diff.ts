// Turns a before/after pair into a git-style unified diff for previews.
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";

const CONTEXT_LINES = 3;

/** Returns "" when nothing changed. Paths are shown with forward slashes. */
export function createUnifiedDiff(
  path: string,
  before: string,
  after: string,
): string {
  if (before === after) return "";
  const displayPath = path.replace(/\\/g, "/");
  return createTwoFilesPatch(
    `a/${displayPath}`,
    `b/${displayPath}`,
    before,
    after,
    undefined,
    undefined,
    { context: CONTEXT_LINES, headerOptions: FILE_HEADERS_ONLY },
  );
}
