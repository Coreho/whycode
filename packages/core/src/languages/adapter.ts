// The contract every supported language implements (formatter, comment
// syntax, comment-free token stream), plus lookup of an adapter by file path.
import { extname } from "node:path";

export interface LanguageAdapter {
  /** Stable language name, e.g. "python". */
  id: string;
  /** Lowercase file extensions including the dot, e.g. [".py"]. */
  extensions: string[];
  /** Marker that starts a single-line comment, e.g. "#". */
  lineComment: string;
  /** Optional docstring / JSDoc builder for summaries above definitions. */
  docComment?: (summary: string, indent: string) => string;
  /**
   * Formats code; `formatted` is false when the formatter isn't installed.
   * `filePath` lets the formatter find the project's own settings.
   */
  format(
    code: string,
    filePath?: string,
  ): Promise<{ code: string; formatted: boolean }>;
  /** Every token of the code except comments, in source order. */
  tokens(code: string): Promise<string[]>;
  /**
   * The formatter, and whether the project around a file has adopted it (a
   * config file or dependency). WhyCode only runs a formatter the project
   * uses unless told otherwise. Omitted: always format (gofmt, rustfmt).
   */
  formatter?: {
    name: string;
    isAdopted(filePath: string): Promise<boolean>;
  };
}

/** Lowercase extension of a path including the dot, or "" if it has none. */
export function fileExtension(path: string): string {
  return extname(path).toLowerCase();
}

export function findAdapterForPath(
  path: string,
  adapters: readonly LanguageAdapter[],
): LanguageAdapter | undefined {
  const extension = fileExtension(path);
  if (extension === "") return undefined;
  return adapters.find((adapter) =>
    adapter.extensions.some(
      (candidate) => candidate.toLowerCase() === extension,
    ),
  );
}
