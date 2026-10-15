// Shared tree-sitter plumbing for language adapters: loads the WASM runtime
// and grammars once per process, and extracts the comment-free token stream
// that the logic-unchanged check compares.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Language, Parser } from "web-tree-sitter";
import type { Node, TreeCursor } from "web-tree-sitter";

export interface GrammarSpec {
  /** npm package that ships the grammar, e.g. "tree-sitter-python". */
  packageName: string;
  /** The .wasm file inside that package. */
  wasmFile: string;
}

export interface TokenRules {
  /** Node types that are comments, and so are left out of the token stream. */
  commentTypes: ReadonlySet<string>;
  /**
   * Node types after which a comment changes what the code means, such as
   * Python's backslash line continuation. A comment there becomes a token.
   */
  commentSensitiveTypes?: ReadonlySet<string>;
  /**
   * Bracketed lists whose trailing comma (one right before the closing
   * bracket) can't change meaning, keyed by node type. Formatters add these
   * commas when they split a list over several lines, so they are left out
   * of the token stream. "with-several-items" applies only when the list has
   * another comma too: in Python, (x,) is a tuple but (x) is not.
   */
  optionalTrailingCommas?: ReadonlyMap<string, TrailingCommaRule>;
}

export type TrailingCommaRule = "always" | "with-several-items";

const OPENING_BRACKETS = new Set(["(", "[", "{", "<"]);
const CLOSING_BRACKETS = new Set([")", "]", "}", ">"]);

// Marker tokens. They can't collide with real tokens, which never contain "<<".
export const SYNTAX_ERROR_TOKEN = "<<syntax-error>>";
export const COMMENT_AFTER_CONTINUATION_TOKEN =
  "<<comment-after-line-continuation>>";
const missingToken = (type: string) => `<<missing ${type}>>`;

const require = createRequire(import.meta.url);
let runtimeReady: Promise<void> | undefined;
const grammarCache = new Map<string, Promise<Language>>();

/** Loads a grammar's WASM file, at most once per process. */
export function loadGrammar(grammar: GrammarSpec): Promise<Language> {
  const key = `${grammar.packageName}/${grammar.wasmFile}`;
  let language = grammarCache.get(key);
  if (language === undefined) {
    runtimeReady ??= Parser.init();
    language = runtimeReady.then(() => Language.load(grammarPath(grammar)));
    grammarCache.set(key, language);
  }
  return language;
}

// Grammar packages don't list their .wasm files in "exports", so find the
// file next to the package's package.json.
function grammarPath(grammar: GrammarSpec): string {
  const packageJson = require.resolve(`${grammar.packageName}/package.json`);
  return join(dirname(packageJson), grammar.wasmFile);
}

/**
 * Every token of the code except comments and optional trailing commas, in
 * source order. Whitespace between tokens is ignored; whitespace inside
 * tokens (such as strings) is kept.
 * Syntax errors appear as marker tokens, so new breakage changes the stream.
 */
export async function treeSitterTokens(
  code: string,
  grammar: GrammarSpec,
  rules: TokenRules,
): Promise<string[]> {
  const language = await loadGrammar(grammar);
  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const tree = parser.parse(code);
    if (tree === null) throw new Error("tree-sitter could not parse the code.");
    const cursor = tree.walk();
    try {
      return collectTokens(cursor, code, rules);
    } finally {
      cursor.delete();
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

/**
 * Walks the tree depth-first without recursion, so deeply nested code can't
 * overflow the call stack. Emits leaf text, plus any non-whitespace text
 * that no node covers (some grammars leave string contents uncovered).
 */
function collectTokens(
  cursor: TreeCursor,
  code: string,
  rules: TokenRules,
): string[] {
  const tokens: string[] = [];
  let coveredUntil = 0;
  let previousLeafType = "";

  const emitUncoveredText = (until: number) => {
    const text = code.slice(coveredUntil, until);
    if (text.trim() !== "") tokens.push(text);
    coveredUntil = Math.max(coveredUntil, until);
  };

  /** Records one node; returns true if the walk should go into its children. */
  const visit = (node: Node): boolean => {
    if (rules.commentTypes.has(node.type)) {
      emitUncoveredText(node.startIndex);
      if (rules.commentSensitiveTypes?.has(previousLeafType)) {
        tokens.push(COMMENT_AFTER_CONTINUATION_TOKEN);
      }
      coveredUntil = node.endIndex;
      return false;
    }
    if (node.isMissing) {
      tokens.push(missingToken(node.type));
      return false;
    }
    if (node.isError) tokens.push(SYNTAX_ERROR_TOKEN);
    if (node.childCount > 0) return true;

    emitUncoveredText(node.startIndex);
    const text = code.slice(node.startIndex, node.endIndex);
    if (text !== "" && !isOptionalTrailingComma(node, rules)) tokens.push(text);
    coveredUntil = node.endIndex;
    previousLeafType = node.type;
    return false;
  };

  let enterNode = true;
  for (;;) {
    if (enterNode && visit(cursor.currentNode) && cursor.gotoFirstChild())
      continue;
    if (cursor.gotoNextSibling()) {
      enterNode = true;
    } else if (cursor.gotoParent()) {
      enterNode = false;
    } else {
      break;
    }
  }
  emitUncoveredText(code.length);
  return tokens;
}

/**
 * True for a "," that follows a list item and directly precedes the list's
 * closing bracket, in a list where the language's rules say such a comma
 * can't change meaning. A comma after "(" or another "," is not trailing:
 * in JavaScript, [,] and [a,,] contain holes.
 */
function isOptionalTrailingComma(node: Node, rules: TokenRules): boolean {
  if (node.type !== "," || node.parent === null) return false;
  const rule = rules.optionalTrailingCommas?.get(node.parent.type);
  if (rule === undefined) return false;
  const before = siblingPastComments(node, "previous", rules);
  const after = siblingPastComments(node, "next", rules);
  if (before === null || after === null) return false;
  if (before.type === "," || OPENING_BRACKETS.has(before.type)) return false;
  if (!CLOSING_BRACKETS.has(after.type)) return false;
  return rule === "always" || countCommas(node.parent) > 1;
}

function siblingPastComments(
  node: Node,
  direction: "previous" | "next",
  rules: TokenRules,
): Node | null {
  const step = (from: Node) =>
    direction === "next" ? from.nextSibling : from.previousSibling;
  let sibling = step(node);
  while (sibling !== null && rules.commentTypes.has(sibling.type)) {
    sibling = step(sibling);
  }
  return sibling;
}

function countCommas(list: Node): number {
  return list.children.filter((child) => child.type === ",").length;
}
