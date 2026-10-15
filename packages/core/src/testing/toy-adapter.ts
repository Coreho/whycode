// Adapter for "toy", a made-up language for tests. It behaves like a real
// adapter without tree-sitter: "#" starts a comment and tokens are the
// whitespace-separated words outside comments.
import type { LanguageAdapter } from "../languages/adapter.js";

export interface ToyAdapterOptions {
  /** false simulates a formatter that isn't installed. Default: true. */
  formatterAvailable?: boolean;
  /** Applied on every format call after the first, simulating a buggy formatter. */
  corruptOnReformat?: (code: string) => string;
}

export function createToyAdapter(
  options: ToyAdapterOptions = {},
): LanguageAdapter {
  let formatCalls = 0;
  return {
    id: "toy",
    extensions: [".toy"],
    lineComment: "#",
    format(code) {
      formatCalls += 1;
      if (options.formatterAvailable === false) {
        return Promise.resolve({ code, formatted: false });
      }
      const tidy = formatToyCode(code);
      const corrupt = formatCalls > 1 ? options.corruptOnReformat : undefined;
      return Promise.resolve({
        code: corrupt ? corrupt(tidy) : tidy,
        formatted: true,
      });
    },
    tokens(code) {
      return Promise.resolve(toyTokens(code));
    },
  };
}

/** Strips trailing whitespace and collapses runs of blank lines into one. */
export function formatToyCode(code: string): string {
  const lines = code.split("\n").map((line) => line.trimEnd());
  return lines
    .filter((line, index) => !(line === "" && lines[index - 1] === ""))
    .join("\n");
}

export function toyTokens(code: string): string[] {
  return code
    .split("\n")
    .flatMap((line) => withoutComment(line).split(/\s+/).filter(Boolean));
}

function withoutComment(line: string): string {
  const commentStart = line.indexOf("#");
  return commentStart === -1 ? line : line.slice(0, commentStart);
}
