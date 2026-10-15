// Java support: google-java-format formats stdin, and tree-sitter verifies tokens.
// Escape-bearing comments are significant because javac decodes them before lexing.
import { Parser } from "web-tree-sitter";
import type { ProcessRunner } from "../process.js";
import { runProcess } from "../process.js";
import type { LanguageAdapter } from "./adapter.js";
import type { GrammarSpec, TokenRules } from "./tree-sitter.js";
import { loadGrammar, treeSitterTokens } from "./tree-sitter.js";

const JAVA_GRAMMAR: GrammarSpec = {
  packageName: "tree-sitter-java",
  wasmFile: "tree-sitter-java.wasm",
};

const JAVA_TOKEN_RULES: TokenRules = {
  commentTypes: new Set(["line_comment", "block_comment"]),
};

export interface JavaAdapterOptions {
  /** Replaces the subprocess runner; used by tests. */
  runProcess?: ProcessRunner;
}

export function createJavaAdapter(
  options: JavaAdapterOptions = {},
): LanguageAdapter {
  const run = options.runProcess ?? runProcess;
  return {
    id: "java",
    extensions: [".java"],
    lineComment: "//",
    format: (code) => formatWithGoogleJavaFormat(code, run),
    tokens: javaTokens,
  };
}

export const javaAdapter = createJavaAdapter();

async function javaTokens(code: string): Promise<string[]> {
  const tokens = await treeSitterTokens(code, JAVA_GRAMMAR, JAVA_TOKEN_RULES);
  if (!code.includes("\\u")) return tokens;
  // Existing escapes can open comments or strings that the raw grammar cannot
  // see. Check javac's translated view too, while retaining the raw tokens.
  const decoded = decodeUnicodeEscapes(code);
  const decodedTokens =
    decoded === code
      ? []
      : [
          "<<unicode-decoded-tokens>>",
          ...(await treeSitterTokens(decoded, JAVA_GRAMMAR, JAVA_TOKEN_RULES)),
        ];
  return [...tokens, ...decodedTokens, ...(await unicodeCommentTokens(code))];
}

/** JLS 3.3: raw backslash parity controls eligibility; decoded text is not rescanned. */
function decodeUnicodeEscapes(code: string): string {
  const escape = /\\u+([0-9a-fA-F]{4})/y;
  const characters: string[] = [];
  let backslashes = 0;
  let previousWasEscape = false;
  for (let index = 0; index < code.length; index++) {
    let character = code[index] ?? "";
    const eligible: boolean = previousWasEscape || backslashes % 2 === 0;
    escape.lastIndex = index;
    const match: RegExpExecArray | null =
      character === "\\" && eligible ? escape.exec(code) : null;
    if (match !== null) {
      character = String.fromCharCode(Number.parseInt(match[1] ?? "", 16));
      index = escape.lastIndex - 1;
    }
    characters.push(character);
    backslashes = character === "\\" ? backslashes + 1 : 0;
    previousWasEscape = match !== null;
  }
  return characters.join("");
}

/** Keep raw comment text even for harmless escapes; decoding eligibility is subtle. */
async function unicodeCommentTokens(code: string): Promise<string[]> {
  const parser = new Parser();
  try {
    parser.setLanguage(await loadGrammar(JAVA_GRAMMAR));
    const tree = parser.parse(code);
    if (tree === null) throw new Error("tree-sitter could not parse the code.");
    try {
      return (
        tree.rootNode
          .descendantsOfType([...JAVA_TOKEN_RULES.commentTypes])
          // Protect every backslash-u candidate, including all /\\u+[0-9a-fA-F]{4}/
          // matches: javac rejects malformed escapes too, even inside comments.
          .filter((comment) => comment.text.includes("\\u"))
          .flatMap((comment) => ["<<unicode-escape-in-comment>>", comment.text])
      );
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

/** Format stdin, preserving imports, literal tokens, modifiers and existing Javadoc. */
export async function formatWithGoogleJavaFormat(
  code: string,
  run: ProcessRunner,
): Promise<{ code: string; formatted: boolean }> {
  const result = await run(
    "google-java-format",
    [
      "--skip-sorting-imports",
      "--skip-removing-unused-imports",
      "--skip-reflowing-long-strings",
      "--skip-javadoc-formatting",
      "--skip-reordering-modifiers",
      "-",
    ],
    code,
  );
  if (result.kind === "not-found") return { code, formatted: false };
  if (result.exitCode !== 0) {
    const detail =
      result.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";
    throw new Error(
      `google-java-format failed (exit code ${result.exitCode}): ${detail}`,
    );
  }
  return { code: result.stdout, formatted: true };
}
