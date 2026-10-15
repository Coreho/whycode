// TypeScript and JavaScript support, including JSX and the .mts/.cts/.mjs/.cjs
// variants. Prettier formats the code (as a library), and tree-sitter supplies
// the comment-free tokens. Each dialect needs its own grammar, so this file
// exports three adapters.
import * as prettier from "prettier";
import type { LanguageAdapter } from "./adapter.js";
import type { GrammarSpec, TokenRules } from "./tree-sitter.js";
import { treeSitterTokens } from "./tree-sitter.js";

interface ScriptDialect {
  id: string;
  extensions: string[];
  grammar: GrammarSpec;
  /** Used to pick Prettier's parser when the caller gives no file path. */
  fallbackFileName: string;
}

const SCRIPT_TOKEN_RULES: TokenRules = {
  // html_comment is the legacy "<!--" comment some JavaScript engines accept.
  commentTypes: new Set(["comment", "html_comment"]),
  // Prettier adds a trailing comma when it splits a list one item per line.
  // In TSX, <T,> marks a generic arrow function rather than a JSX tag, so a
  // lone type parameter's comma still counts.
  optionalTrailingCommas: new Map([
    ["arguments", "always"],
    ["formal_parameters", "always"],
    ["array", "always"],
    ["object", "always"],
    ["array_pattern", "always"],
    ["object_pattern", "always"],
    ["named_imports", "always"],
    ["export_clause", "always"],
    ["enum_body", "always"],
    ["object_type", "always"],
    ["tuple_type", "always"],
    ["type_arguments", "always"],
    ["type_parameters", "with-several-items"],
  ]),
};

function createScriptAdapter(dialect: ScriptDialect): LanguageAdapter {
  return {
    id: dialect.id,
    extensions: dialect.extensions,
    lineComment: "//",
    format: (code, filePath) =>
      formatWithPrettier(code, filePath ?? dialect.fallbackFileName),
    tokens: (code) =>
      treeSitterTokens(code, dialect.grammar, SCRIPT_TOKEN_RULES),
  };
}

export const typescriptAdapter = createScriptAdapter({
  id: "typescript",
  extensions: [".ts", ".mts", ".cts"],
  grammar: {
    packageName: "tree-sitter-typescript",
    wasmFile: "tree-sitter-typescript.wasm",
  },
  fallbackFileName: "file.ts",
});

export const tsxAdapter = createScriptAdapter({
  id: "tsx",
  extensions: [".tsx"],
  grammar: {
    packageName: "tree-sitter-typescript",
    wasmFile: "tree-sitter-tsx.wasm",
  },
  fallbackFileName: "file.tsx",
});

export const javascriptAdapter = createScriptAdapter({
  id: "javascript",
  extensions: [".js", ".mjs", ".cjs", ".jsx"],
  grammar: {
    packageName: "tree-sitter-javascript",
    wasmFile: "tree-sitter-javascript.wasm",
  },
  fallbackFileName: "file.js",
});

/**
 * Formats with the project's own Prettier settings (.prettierrc, and
 * .editorconfig as the Prettier CLI does), found from the file's location.
 * Prettier is bundled, so formatting is always available.
 */
export async function formatWithPrettier(
  code: string,
  filePath: string,
): Promise<{ code: string; formatted: boolean }> {
  const projectOptions = await prettier.resolveConfig(filePath, {
    editorconfig: true,
  });
  const formatted = await prettier.format(code, {
    ...projectOptions,
    filepath: filePath,
  });
  return { code: formatted, formatted: true };
}
