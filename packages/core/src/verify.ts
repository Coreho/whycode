// The logic-unchanged check: the code's tokens, ignoring comments, must be
// exactly the same before and after WhyCode's edits.

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

/** Human-readable explanation of a mismatch, for warnings and reports. */
export function describeTokenMismatch(comparison: TokenComparison): string {
  if (comparison.equal) return "tokens match";
  const show = (token: string | undefined) =>
    token === undefined ? "end of code" : `"${token}"`;
  return `token ${comparison.index + 1}: expected ${show(comparison.expected)}, found ${show(comparison.actual)}`;
}
