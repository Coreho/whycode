// `--json` output for check and fix: one JSON document on stdout with each
// file's hashes, verdict and verification, so CI and other tools never have
// to parse terminal text. The usual text goes to stderr meanwhile.
import { createHash } from "node:crypto";
import type {
  ExistingCommentSuggestion,
  FileResult,
  VerdictKind,
} from "@whycode/core";
import { fileVerdict } from "@whycode/core";
import type { CliIo } from "./io.js";
import type { Skip } from "./report.js";
import { cliVersion } from "./version.js";

export interface JsonFile {
  path: string;
  /** SHA-256 of the file as read. */
  inputSha256: string;
  /** SHA-256 of the result: the proposed code (check) or what is on disk afterwards (fix). */
  outputSha256: string;
  /** fix only: whether the changes were written. */
  written?: boolean;
  verdict: VerdictKind;
  verdictText: string;
  verification: {
    /** "tokens": comment insertion was checked against the code's tokens; "none": comments-only language. */
    method: "tokens" | "none";
    outcome: FileResult["verification"];
  };
  commentsAdded: number;
  formatted: boolean;
  warnings: string[];
  /** Suggested rewrites of existing comments that nobody accepted. */
  suggestions: ExistingCommentSuggestion[];
}

export interface JsonReport {
  tool: "whycode";
  version: string;
  command: "check" | "fix";
  exitCode: number;
  files: JsonFile[];
  /** Paths that were passed over, with the reason. */
  skipped: Skip[];
}

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/** One file's entry; fix passes `written`, and an unwritten file keeps its input. */
export function jsonFile(result: FileResult, written?: boolean): JsonFile {
  const verdict = fileVerdict(result);
  const output = written === false ? result.originalCode : result.outputCode;
  return {
    path: result.path,
    inputSha256: sha256(result.originalCode),
    outputSha256: sha256(output),
    ...(written === undefined ? {} : { written }),
    verdict: verdict.kind,
    verdictText: verdict.text,
    verification: {
      method: result.mode === "full" ? "tokens" : "none",
      outcome: result.verification,
    },
    commentsAdded: result.commentsAdded,
    formatted: result.formatted,
    warnings: result.warnings,
    suggestions: result.commentSuggestions,
  };
}

export function renderJsonReport(
  report: Omit<JsonReport, "tool" | "version">,
): string {
  const full: JsonReport = {
    tool: "whycode",
    version: cliVersion(),
    ...report,
  };
  return `${JSON.stringify(full, null, 2)}\n`;
}

/** The io a --json run prints its usual text to: stderr, keeping stdout for the report. */
export function textOnStderr(io: CliIo): CliIo {
  return { ...io, stdout: (text) => io.stderr(text) };
}
