// Go support: gofmt formats stdin, and tree-sitter supplies verification tokens.
// Cgo preambles are executable C, so their comments must also be verified.
import { Parser } from "web-tree-sitter";
import type { Node } from "web-tree-sitter";
import type { ProcessRunner } from "../process.js";
import { runProcess } from "../process.js";
import type { LanguageAdapter } from "./adapter.js";
import type { GrammarSpec, TokenRules } from "./tree-sitter.js";
import { loadGrammar, treeSitterTokens } from "./tree-sitter.js";

const GO_GRAMMAR: GrammarSpec = {
  packageName: "tree-sitter-go",
  wasmFile: "tree-sitter-go.wasm",
};

const GO_TOKEN_RULES: TokenRules = {
  commentTypes: new Set(["comment"]),
};

export interface GoAdapterOptions {
  /** Replaces the subprocess runner; used by tests. */
  runProcess?: ProcessRunner;
}

export function createGoAdapter(
  options: GoAdapterOptions = {},
): LanguageAdapter {
  const run = options.runProcess ?? runProcess;
  return {
    id: "go",
    extensions: [".go"],
    lineComment: "//",
    format: (code) => formatWithGofmt(code, run),
    tokens: goTokens,
  };
}

export const goAdapter = createGoAdapter();

async function goTokens(code: string): Promise<string[]> {
  const tokens = await treeSitterTokens(code, GO_GRAMMAR, GO_TOKEN_RULES);
  // Only files that import "C" have a preamble, so most skip the second parse.
  if (!code.includes('"C"')) return tokens;
  return [...tokens, ...(await cgoPreambleTokens(code))];
}

/** A marker plus the raw text of each cgo preamble, so edits to it are caught. */
async function cgoPreambleTokens(code: string): Promise<string[]> {
  const parser = new Parser();
  try {
    parser.setLanguage(await loadGrammar(GO_GRAMMAR));
    const tree = parser.parse(code);
    if (tree === null) throw new Error("tree-sitter could not parse the code.");
    try {
      return findCgoPreambles(tree.rootNode, code).flatMap((preamble) => [
        "<<cgo-preamble>>",
        preamble,
      ]);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

function findCgoPreambles(root: Node, code: string): string[] {
  const comments = root.descendantsOfType("comment");
  const preambles: string[] = [];
  for (const declaration of root.namedChildren) {
    if (declaration.type !== "import_declaration") continue;
    const specs = declaration.descendantsOfType("import_spec");
    for (const spec of specs) {
      if (spec.childForFieldName("path")?.text !== '"C"') continue;
      // Match cgo's ImportSpec.Doc, then its single-spec GenDecl.Doc fallback.
      const preamble =
        precedingCommentGroup(spec, comments, code) ??
        (specs.length === 1
          ? precedingCommentGroup(declaration, comments, code)
          : undefined);
      if (preamble !== undefined) preambles.push(preamble);
    }
  }
  return preambles;
}

/** Adjacent comments form a group; a blank line or intervening code ends it. */
function precedingCommentGroup(
  target: Node,
  comments: readonly Node[],
  code: string,
): string | undefined {
  const group: Node[] = [];
  let next = target;
  for (let index = comments.length - 1; index >= 0; index--) {
    const comment = comments[index];
    if (comment === undefined || comment.endIndex > next.startIndex) continue;
    const gap = code.slice(comment.endIndex, next.startIndex);
    const lineGap = next.startPosition.row - comment.endPosition.row;
    if (gap.trim() !== "" || lineGap > 1) break;
    // A doc group must end on the line immediately before its declaration.
    if (group.length === 0 && lineGap !== 1) break;
    group.unshift(comment);
    next = comment;
  }
  // Go treats comments trailing code as a separate line-comment group.
  const first = group.find((comment) => {
    const lineStart = code.lastIndexOf("\n", comment.startIndex - 1) + 1;
    return code.slice(lineStart, comment.startIndex).trim() === "";
  });
  const last = group.at(-1);
  return first === undefined || last === undefined
    ? undefined
    : code.slice(first.startIndex, last.endIndex);
}

/** gofmt reads stdin without arguments and does not use project config files. */
export async function formatWithGofmt(
  code: string,
  run: ProcessRunner,
): Promise<{ code: string; formatted: boolean }> {
  const result = await run("gofmt", [], code);
  if (result.kind === "not-found") return { code, formatted: false };
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split(/\r?\n/)[0] ?? "";
    throw new Error(`gofmt failed (exit code ${result.exitCode}): ${detail}`);
  }
  return { code: result.stdout, formatted: true };
}
