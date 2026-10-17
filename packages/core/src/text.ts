// Text helpers. Line endings: the pipeline works on LF text internally and
// returns results with the file's original line endings, so CRLF files stay
// CRLF. Hidden characters: removed from AI-written text, and made visible
// when text from a file is shown. Word wrap: for rewritten comments.

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

// Control characters (other than tab and line breaks) could hide text or
// rewrite the terminal when a preview is shown, and Unicode bidirectional
// controls can make a comment display differently from how the compiler
// reads the code around it ("Trojan Source"). None of them reaches a comment.
const HIDDEN_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Removes control and bidirectional-override characters from AI text. */
export function withoutHiddenCharacters(text: string): string {
  return text.replace(HIDDEN_CHARACTERS, "");
}

// Line breaks that HIDDEN_CHARACTERS leaves alone but some programs honor.
const UNICODE_LINE_BREAKS = new Set(
  [0x85, 0x2028, 0x2029].map((code) => String.fromCharCode(code)),
);

/**
 * Text to show on one line: \n and \r stand for line breaks, and every other
 * hidden character (including Unicode line separators) becomes a \u{...}
 * escape, so nothing in it can break the line or hide.
 */
export function visibleText(text: string): string {
  return [...text]
    .map((char) => {
      if (char === "\n") return "\\n";
      if (char === "\r") return "\\r";
      const hidden =
        withoutHiddenCharacters(char) === "" || UNICODE_LINE_BREAKS.has(char);
      return hidden ? `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}` : char;
    })
    .join("");
}

/** Greedy word wrap: the first line takes `firstPrefix`, later ones `nextPrefix`. */
export function wrapWords(
  text: string,
  firstPrefix: string,
  nextPrefix: string,
  width: number,
): string[] {
  const out: string[] = [];
  let current = "";
  const prefix = () => (out.length === 0 ? firstPrefix : nextPrefix);
  for (const word of text.split(" ")) {
    if (current !== "" && `${prefix()}${current} ${word}`.length > width) {
      out.push(`${prefix()}${current}`);
      current = word;
    } else {
      current = current === "" ? word : `${current} ${word}`;
    }
  }
  out.push(`${prefix()}${current}`);
  return out;
}
