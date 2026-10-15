// Line-ending helpers. The pipeline works on LF text internally and returns
// results with the file's original line endings, so CRLF files stay CRLF.

export type LineEnding = "\n" | "\r\n";

export function detectLineEnding(text: string): LineEnding {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Number of lines in LF text; a trailing newline doesn't start a new line. */
export function countLines(lfText: string): number {
  if (lfText === "") return 0;
  const parts = lfText.split("\n").length;
  return lfText.endsWith("\n") ? parts - 1 : parts;
}

/** Converts LF text back to the given line ending. */
export function restoreLineEnding(
  lfText: string,
  lineEnding: LineEnding,
): string {
  return lineEnding === "\n" ? lfText : lfText.replace(/\n/g, "\r\n");
}
