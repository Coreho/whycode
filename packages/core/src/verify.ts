// The logic-unchanged check: the code's tokens, ignoring comments, must be
// exactly the same before and after WhyCode's edits.
import { visibleText } from "./text.js";

export type TokenComparison =
  | { equal: true }
  | {
      equal: false;
      /** 0-based position of the first differing token. */
      index: number;
      /** Token before the edit; undefined if the edited code is longer. */
      expected: string | undefined;
      /** Token after the edit; undefined if the edited code is shorter. */
      actual: string | undefined;
    };

export function compareTokenStreams(
  before: readonly string[],
  after: readonly string[],
): TokenComparison {
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index++) {
    if (before[index] !== after[index]) {
      return {
        equal: false,
        index,
        expected: before[index],
        actual: after[index],
      };
    }
  }
  return { equal: true };
}

// A token can be a whole multi-line string, so each is shown on one line and
// cut to a window that starts a little before the first differing character.
const CONTEXT_BEFORE = 20;
const MAX_SHOWN = 60;

/** Human-readable explanation of a mismatch, for warnings and reports. */
export function describeTokenMismatch(comparison: TokenComparison): string {
  if (comparison.equal) return "tokens match";
  const expected = shownCharacters(comparison.expected);
  const actual = shownCharacters(comparison.actual);
  const start = Math.max(
    0,
    commonPrefixLength(expected ?? [], actual ?? []) - CONTEXT_BEFORE,
  );
  const show = (token: string[] | undefined) =>
    token === undefined ? "end of code" : `"${excerpt(token, start)}"`;
  return `token ${comparison.index + 1}: expected ${show(expected)}, found ${show(actual)}`;
}

/** The token as visible characters, split by code point. */
function shownCharacters(token: string | undefined): string[] | undefined {
  return token === undefined ? undefined : [...visibleText(token)];
}

function commonPrefixLength(a: string[], b: string[]): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) {
    length += 1;
  }
  return length;
}

function excerpt(characters: string[], start: number): string {
  const end = start + MAX_SHOWN;
  const before = start > 0 ? "..." : "";
  const after = end < characters.length ? "..." : "";
  return `${before}${characters.slice(start, end).join("")}${after}`;
}
