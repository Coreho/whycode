// Turns pipeline results into terminal text: a diff per changed file (with
// a warning and the AI's change list for refactor rewrites), its notes and
// comment suggestions, and at the end the skipped paths grouped by reason
// and a summary. Pure functions, no I/O.
import { styleText } from "node:util";
import { withoutHiddenCharacters } from "@whycode/core";
import type {
  ExistingCommentSuggestion,
  FileResult,
  FileVerdict,
  VerdictKind,
} from "@whycode/core";

export interface Skip {
  path: string;
  reason: string;
}

type TextStyle = Parameters<typeof styleText>[0];
export type Paint = (style: TextStyle, text: string) => string;

/** Colors text only when the terminal shows colors; WhyCode decides that itself. */
export function painter(color: boolean): Paint {
  return color
    ? (style, text) => styleText(style, text, { validateStream: false })
    : (_style, text) => text;
}

const VERDICT_STYLES: Readonly<Record<VerdictKind, TextStyle>> = {
  unchanged: "dim",
  verified: "green",
  discarded: "yellow",
  unverified: "yellow",
  refactored: ["bold", "red"],
  failed: "red",
};

/** "src/a.py: 2 comments added; ..." on one line, colored by outcome. */
export function renderVerdict(
  path: string,
  verdict: FileVerdict,
  paint: Paint,
): string {
  return `${paint(VERDICT_STYLES[verdict.kind], `${path}: ${verdict.text}`)}\n`;
}

/** Most paths shown per group; the rest are counted. */
const MAX_PATHS_PER_GROUP = 10;
/** Lines of failing test output shown under a refactor rewrite. */
const TEST_OUTPUT_LINES = 20;

/** Everything worth showing for one file, or "" when there is nothing. */
export function renderFileResult(result: FileResult, paint: Paint): string {
  return joinSections([
    renderPreview(result, paint),
    renderSuggestions(result.path, result.commentSuggestions, paint),
  ]);
}

/** What a person reviews before accepting a file: the diff and its context. */
export function renderPreview(result: FileResult, paint: Paint): string {
  return joinSections([
    result.changesLogic && result.diff !== ""
      ? renderRefactorWarning(result, paint)
      : "",
    result.diff === "" ? "" : renderDiff(result.diff, paint),
    renderRefactorDetails(result, paint),
    renderNotes(result, paint),
  ]);
}

function joinSections(sections: readonly string[]): string {
  return sections.filter((section) => section !== "").join("\n");
}

function renderDiff(diff: string, paint: Paint): string {
  const lines = diff.replace(/\n$/, "").split("\n");
  return `${lines.map((line) => paintDiffLine(line, paint)).join("\n")}\n`;
}

function paintDiffLine(line: string, paint: Paint): string {
  if (line.startsWith("---") || line.startsWith("+++")) {
    return paint("bold", line);
  }
  if (line.startsWith("@@")) return paint("cyan", line);
  if (line.startsWith("+")) return paint("green", line);
  if (line.startsWith("-")) return paint("red", line);
  return line;
}

function renderRefactorWarning(result: FileResult, paint: Paint): string {
  const warning = `WARNING: this rewrite of ${result.path} may change how the code behaves. Review it carefully.`;
  return `${paint(["bold", "red"], warning)}\n`;
}

/** The AI's list of changes and the test outcome, for refactor rewrites. */
function renderRefactorDetails(result: FileResult, paint: Paint): string {
  const lines: string[] = [];
  if (result.refactorChanges.length > 0) {
    lines.push(paint("bold", "Changes the AI says it made:"));
    lines.push(...result.refactorChanges.map((change) => `  - ${change}`));
  }
  const tests = result.testResult;
  if (tests?.passed === true) {
    lines.push(paint("green", `Tests passed (${tests.command}).`));
  } else if (tests !== undefined) {
    lines.push(
      paint(
        "red",
        `Tests FAILED (${tests.command}, exit code ${tests.exitCode}):`,
      ),
    );
    lines.push(...lastLines(tests.output, TEST_OUTPUT_LINES));
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function lastLines(text: string, count: number): string[] {
  return text
    .trimEnd()
    .split("\n")
    .slice(-count)
    .map((line) => `  | ${line}`);
}

function renderNotes(result: FileResult, paint: Paint): string {
  if (result.warnings.length === 0) return "";
  const heading = paint("yellow", `Notes for ${result.path}:`);
  const notes = result.warnings.map((warning) => `  - ${warning}`);
  return `${[heading, ...notes].join("\n")}\n`;
}

function renderSuggestions(
  path: string,
  suggestions: readonly ExistingCommentSuggestion[],
  paint: Paint,
): string {
  if (suggestions.length === 0) return "";
  const heading = paint(
    "bold",
    `Suggested rewrites of existing comments in ${path}:`,
  );
  const items = suggestions.map((suggestion) =>
    renderSuggestionBody(suggestion, paint),
  );
  return `${[heading, ...items].join("\n")}\n`;
}

/** One suggestion on its own, for reviewing them one at a time. */
export function renderSuggestion(
  path: string,
  suggestion: ExistingCommentSuggestion,
  position: { index: number; total: number },
  paint: Paint,
): string {
  const heading = paint(
    "bold",
    `Suggested rewrite of an existing comment in ${path} (${position.index} of ${position.total}):`,
  );
  return `${heading}\n${renderSuggestionBody(suggestion, paint)}\n`;
}

function renderSuggestionBody(
  suggestion: ExistingCommentSuggestion,
  paint: Paint,
): string {
  return [
    `  line ${suggestion.line}:`,
    ...markLines("-", suggestion.original).map((line) => paint("red", line)),
    ...markLines("+", suggestion.suggested).map((line) => paint("green", line)),
    `    why: ${oneLine(suggestion.reason)}`,
  ].join("\n");
}

// Every line break a compiler may honor. AI-written text is shown without
// them and without hidden characters, which could rewrite the terminal or
// make the text read differently from what it contains.
const DISPLAY_LINE_BREAKS = /\r\n|[\n\r\u0085\u2028\u2029]/;

/** Indents each line of a (possibly multi-line) comment behind a diff marker. */
function markLines(marker: string, text: string): string[] {
  return text
    .trim()
    .split(DISPLAY_LINE_BREAKS)
    .map(withoutHiddenCharacters)
    .map((line) => `    ${marker} ${line.trimEnd()}`);
}

/** AI-written text as one clean line. */
function oneLine(text: string): string {
  return text
    .trim()
    .split(DISPLAY_LINE_BREAKS)
    .map(withoutHiddenCharacters)
    .join(" ");
}

/** Skipped paths grouped under their reason, long groups shortened. */
export function renderSkips(skips: readonly Skip[], paint: Paint): string {
  if (skips.length === 0) return "";
  const heading = paint("bold", `Skipped ${countOf(skips.length, "path")}:`);
  return renderByReason(heading, skips);
}

/** Files the pipeline could not process, e.g. because the AI call failed. */
export function renderFailures(
  failures: readonly Skip[],
  paint: Paint,
): string {
  if (failures.length === 0) return "";
  const heading = paint(
    "red",
    `Could not process ${countOf(failures.length, "file")}:`,
  );
  return renderByReason(heading, failures);
}

function renderByReason(heading: string, skips: readonly Skip[]): string {
  const byReason = new Map<string, string[]>();
  for (const skip of skips) {
    byReason.set(skip.reason, [
      ...(byReason.get(skip.reason) ?? []),
      skip.path,
    ]);
  }
  const lines = [heading];
  for (const [reason, paths] of byReason) {
    lines.push(`  ${reason}:`, ...pathLines(paths));
  }
  return `${lines.join("\n")}\n`;
}

function pathLines(paths: readonly string[]): string[] {
  const lines = paths
    .slice(0, MAX_PATHS_PER_GROUP)
    .map((path) => `    ${path}`);
  if (paths.length > MAX_PATHS_PER_GROUP) {
    lines.push(`    ...and ${paths.length - MAX_PATHS_PER_GROUP} more`);
  }
  return lines;
}

export interface CheckSummary {
  changed: number;
  unchanged: number;
  skipped: number;
  failed: number;
  /** Files whose AI comments failed verification and were thrown away. */
  discarded: number;
  suggestions: number;
}

export function renderSummary(summary: CheckSummary, paint: Paint): string {
  const parts = [
    `${countOf(summary.changed, "file")} would change`,
    `${summary.unchanged} unchanged`,
    `${summary.skipped} skipped`,
  ];
  if (summary.discarded > 0) {
    parts.push(`${summary.discarded} with comments discarded`);
  }
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (summary.suggestions > 0) {
    parts.push(`${countOf(summary.suggestions, "comment suggestion")}`);
  }
  const line = `${parts.join(", ")}.`;
  return `${summary.changed > 0 ? paint("bold", line) : line}\n`;
}

export interface FixGroup {
  label: string;
  paths: readonly string[];
}

/** The end-of-run list of what happened to each file in `fix`. */
export function renderFixSummary(
  groups: readonly FixGroup[],
  paint: Paint,
): string {
  const lines = [paint("bold", "Summary:")];
  for (const { label, paths } of groups) {
    if (paths.length > 0) {
      lines.push(`  ${label} (${paths.length}):`, ...pathLines(paths));
    }
  }
  if (lines.length === 1) lines.push("  Nothing to do.");
  return `${lines.join("\n")}\n`;
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
