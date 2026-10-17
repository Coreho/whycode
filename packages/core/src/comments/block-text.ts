// Rewrites text inside a block comment (/* ... */ or /** ... */) that stands
// on lines of its own, for suggestions that quote part of it the way a model
// reads a doc comment: without the markers and the * at the start of each
// line, and not always on line boundaries. Only the quoted words change. The
// markers, indentation and other lines stay, and the changed lines (with the
// rest of their paragraph) are re-wrapped to the width they had. Token
// verification still checks the result.
import { withoutHiddenCharacters, wrapWords } from "../text.js";
import { LINE_BREAKS } from "./insert.js";

export type BlockTextEdit =
  | { ok: true; start: number; end: number; lines: string[] }
  | { ok: false; reason: string };

interface BlockLine {
  /** Indent and comment marker before the text, e.g. "  /** " or "   * ". */
  prefix: string;
  text: string;
  /** The closing marker and anything after it, on the block's last line. */
  suffix: string;
}

interface Word {
  /** Index into the block's lines. */
  line: number;
  start: number;
  end: number;
  text: string;
}

// Doc blocks are rarely longer than this; a bound keeps the search cheap.
const MAX_BLOCK_LINES = 200;
const MIN_WIDTH = 40;
const SINGLE_LINE_WIDTH = 80;

/**
 * The edit for a suggestion quoting text in the block comment around the
 * given 1-based line, or undefined if that line isn't inside such a block.
 */
export function rewriteInsideBlock(
  texts: readonly string[],
  line: number,
  original: string,
  suggested: string,
): BlockTextEdit | undefined {
  const block = findBlock(texts, line - 1);
  if (block === undefined) return undefined;
  const quoted = proseWords(original);
  if (quoted.length === 0) return undefined;
  const lines = texts.slice(block.start, block.end + 1).map(parseLine);
  const words = wordsOf(lines);
  const at = findOnce(words, quoted);
  if (at === "none") {
    return {
      ok: false,
      reason: `the quoted text isn't in the block comment at line ${line}`,
    };
  }
  if (at === "many") {
    return {
      ok: false,
      reason: `the quoted text appears more than once in the block comment at line ${line}`,
    };
  }
  const replacement = proseWords(withoutHiddenCharacters(suggested)).join(" ");
  if (replacement === "") return { ok: false, reason: "the rewrite is empty" };
  if (replacement.includes("/*") || replacement.includes("*/")) {
    return {
      ok: false,
      reason: "the rewrite would end the comment early or start another one",
    };
  }
  const first = words[at];
  const last = words[at + quoted.length - 1];
  if (first === undefined || last === undefined) return undefined;
  const span = spanToRewrap(lines, first, last);
  return {
    ok: true,
    start: block.start + span.from,
    end: block.start + span.to + 1,
    lines: rebuild(lines, first, last, span, replacement),
  };
}

/** The block comment whose lines include `index`, if it stands on its own lines. */
function findBlock(
  texts: readonly string[],
  index: number,
): { start: number; end: number } | undefined {
  const start = findOpener(texts, index);
  if (start === undefined) return undefined;
  let end = -1;
  for (let i = start; i < texts.length && i - start < MAX_BLOCK_LINES; i++) {
    const text = texts[i] ?? "";
    const from = i === start ? text.indexOf("/*") + 2 : 0;
    if (text.indexOf("*/", from) !== -1) {
      end = i;
      break;
    }
  }
  if (end < index) return undefined;
  const closer = texts[end] ?? "";
  if (closer.slice(closer.lastIndexOf("*/") + 2).trim() !== "")
    return undefined;
  // One comment only: no other opener or closer between its own markers.
  const whole = texts.slice(start, end + 1).join("\n");
  const inner = whole.slice(whole.indexOf("/*") + 2, whole.lastIndexOf("*/"));
  if (inner.includes("/*") || inner.includes("*/")) return undefined;
  return { start, end };
}

/** The line opening the block around `index`, scanning up; undefined if a block closes first. */
function findOpener(
  texts: readonly string[],
  index: number,
): number | undefined {
  for (let i = index; i >= 0 && index - i < MAX_BLOCK_LINES; i--) {
    const text = texts[i] ?? "";
    if (text.trimStart().startsWith("/*")) {
      const closesHere = text.indexOf("*/", text.indexOf("/*") + 2) !== -1;
      return closesHere && i < index ? undefined : i;
    }
    if (i < index && text.includes("*/")) return undefined;
  }
  return undefined;
}

/** Splits a block line into marker prefix, text and closing suffix. */
function parseLine(
  full: string,
  index: number,
  all: readonly string[],
): BlockLine {
  const isLast = index === all.length - 1;
  const closeAt = isLast ? full.lastIndexOf("*/") : -1;
  const rest = closeAt === -1 ? full : full.slice(0, closeAt);
  const suffix = closeAt === -1 ? "" : full.slice(closeAt);
  const marker = index === 0 ? /^\s*\/\*[*!]?\s?/ : /^\s*(?:\*(?!\/)\s?)?/;
  const prefix = marker.exec(rest)?.[0] ?? "";
  return { prefix, text: rest.slice(prefix.length), suffix };
}

function wordsOf(lines: readonly BlockLine[]): Word[] {
  return lines.flatMap((line, index) =>
    [...line.text.matchAll(/\S+/g)].map((match) => ({
      line: index,
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    })),
  );
}

/** Words of comment text, ignoring line breaks, block markers and leading *. */
function proseWords(text: string): string[] {
  return text
    .split(LINE_BREAKS)
    .map((line) =>
      line
        .trim()
        .replace(/^\/\*[*!]?/, "")
        .replace(/\*\/$/, "")
        .replace(/^\*(?!\/)/, ""),
    )
    .join(" ")
    .split(/\s+/)
    .filter((word) => word !== "");
}

/** Where the quoted words start in the block, if they occur exactly once. */
function findOnce(
  words: readonly Word[],
  quoted: readonly string[],
): number | "none" | "many" {
  const starts: number[] = [];
  for (let at = 0; at + quoted.length <= words.length; at++) {
    if (quoted.every((word, offset) => words[at + offset]?.text === word)) {
      starts.push(at);
    }
  }
  if (starts.length === 0) return "none";
  return starts.length === 1 ? (starts[0] ?? "none") : "many";
}

/**
 * Block lines to re-wrap: those holding the quote and, when text follows the
 * quote on its last line, the rest of that paragraph, so no stub is left.
 */
function spanToRewrap(
  lines: readonly BlockLine[],
  first: Word,
  last: Word,
): { from: number; to: number } {
  const lastLine = lines[last.line];
  if (lastLine === undefined || lastLine.text.slice(last.end).trim() === "") {
    return { from: first.line, to: last.line };
  }
  let to = last.line;
  // A paragraph ends at an empty line, a tag (@param) or a list item.
  while (to + 1 < lines.length) {
    const next = (lines[to + 1]?.text ?? "").trim();
    if (next === "" || /^([@\-*+#]|\d+[.)])/.test(next)) break;
    to += 1;
  }
  return { from: first.line, to };
}

/** New lines for the span: text around the quote kept, the rewrite in between. */
function rebuild(
  lines: readonly BlockLine[],
  first: Word,
  last: Word,
  span: { from: number; to: number },
  replacement: string,
): string[] {
  const firstLine = lines[span.from];
  const endLine = lines[span.to];
  if (firstLine === undefined || endLine === undefined) return [];
  const head = firstLine.text.slice(0, first.start).trimEnd();
  const tail = [
    (lines[last.line]?.text ?? "").slice(last.end),
    ...lines.slice(last.line + 1, span.to + 1).map((line) => line.text),
  ];
  const merged = [head, replacement, ...tail.map((text) => text.trim())];
  const wrapped = wrapWords(
    merged.filter((part) => part !== "").join(" "),
    firstLine.prefix,
    continuationPrefix(lines),
    spanWidth(lines.slice(span.from, span.to + 1)),
  );
  if (endLine.suffix !== "") {
    const end = wrapped.length - 1;
    wrapped[end] = `${wrapped[end] ?? ""} ${endLine.suffix}`;
  }
  return wrapped;
}

/**
 * The width the replaced lines were wrapped to, so the new ones match their
 * paragraph. A single line gives no wrap width, so it may grow to 80.
 */
function spanWidth(span: readonly BlockLine[]): number {
  const lengths = span.map(
    (line) => `${line.prefix}${line.text}${line.suffix}`.trimEnd().length,
  );
  const widest = Math.max(MIN_WIDTH, ...lengths);
  return span.length === 1 ? Math.max(widest, SINGLE_LINE_WIDTH) : widest;
}

/** The prefix the block's middle lines use (e.g. "   * "), or a JSDoc-style one. */
function continuationPrefix(lines: readonly BlockLine[]): string {
  const existing = lines.slice(1).find((line) => line.prefix.includes("*"));
  if (existing !== undefined) {
    return existing.prefix.endsWith(" ")
      ? existing.prefix
      : `${existing.prefix} `;
  }
  const indent = /^\s*/.exec(lines[0]?.prefix ?? "")?.[0] ?? "";
  return `${indent} * `;
}
