// Python support: Ruff (an external binary found on PATH) formats the code,
// and tree-sitter supplies the comment-free tokens.
import type { ProcessRunner } from "../process.js";
import { runProcess } from "../process.js";
import type { LanguageAdapter } from "./adapter.js";
import type { GrammarSpec, TokenRules } from "./tree-sitter.js";
import { treeSitterTokens } from "./tree-sitter.js";

const PYTHON_GRAMMAR: GrammarSpec = {
  packageName: "tree-sitter-python",
  wasmFile: "tree-sitter-python.wasm",
};

const PYTHON_TOKEN_RULES: TokenRules = {
  commentTypes: new Set(["comment"]),
  // A comment after "\" breaks the code: the continuation swallows the comment
  // line and the next line becomes a separate statement.
  commentSensitiveTypes: new Set(["line_continuation"]),
};

export interface PythonAdapterOptions {
  /** Replaces the subprocess runner; used by tests. */
  runProcess?: ProcessRunner;
}

export function createPythonAdapter(
  options: PythonAdapterOptions = {},
): LanguageAdapter {
  const run = options.runProcess ?? runProcess;
  return {
    id: "python",
    extensions: [".py", ".pyi"],
    lineComment: "#",
    format: (code, filePath) => formatWithRuff(code, filePath, run),
    tokens: (code) =>
      treeSitterTokens(code, PYTHON_GRAMMAR, PYTHON_TOKEN_RULES),
  };
}

export const pythonAdapter = createPythonAdapter();

/**
 * Formats with `ruff format`, reading code from stdin. Passing the file path
 * lets Ruff apply the project's pyproject.toml or ruff.toml settings.
 */
export async function formatWithRuff(
  code: string,
  filePath: string | undefined,
  run: ProcessRunner,
): Promise<{ code: string; formatted: boolean }> {
  const pathArgs = filePath === undefined ? [] : ["--stdin-filename", filePath];
  const result = await run(
    "ruff",
    ["format", "--quiet", ...pathArgs, "-"],
    code,
  );
  if (result.kind === "not-found") return { code, formatted: false };
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split("\n")[0] ?? "";
    throw new Error(
      `ruff format failed (exit code ${result.exitCode}): ${detail}`,
    );
  }
  return { code: result.stdout, formatted: true };
}
