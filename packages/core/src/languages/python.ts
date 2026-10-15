// Python support: Ruff (an external binary found on PATH) formats the code,
// and tree-sitter supplies the comment-free tokens.
import type { ProcessRunner } from "../process.js";
import { runProcess } from "../process.js";
import type { LanguageAdapter } from "./adapter.js";
import { ruffAdopted } from "./formatter-adoption.js";
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
  // Ruff adds a trailing comma when it splits a list one item per line.
  // Where one item plus a comma means something else, the comma only counts
  // as optional when there are several items: (x,) and a[x,] are tuples, and
  // `case (x,):` matches a one-item sequence.
  optionalTrailingCommas: new Map([
    ["argument_list", "always"],
    ["parameters", "always"],
    ["type_parameter", "always"],
    ["import_from_statement", "always"],
    ["list", "always"],
    ["set", "always"],
    ["dictionary", "always"],
    ["list_pattern", "always"],
    ["dict_pattern", "always"],
    ["class_pattern", "always"],
    ["tuple", "with-several-items"],
    ["tuple_pattern", "with-several-items"],
    ["subscript", "with-several-items"],
  ]),
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
    formatter: { name: "Ruff", isAdopted: ruffAdopted },
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
