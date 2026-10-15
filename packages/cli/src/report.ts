// Turns pipeline results into terminal text: a diff per changed file, then
// its warnings and comment suggestions, and at the end the skipped paths
// grouped by reason and a one-line summary. Pure functions, no I/O.
import { styleText } from "node:util";
import type { ExistingCommentSuggestion, FileResult } from "@whycode/core";

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

/** Most paths shown per skip reason; the rest are counted. */
const MAX_PATHS_PER_REASON = 10;

/** Everything worth showing for one file, or "" when there is nothing. */
export function renderFileResult(result: FileResult, paint: Paint): string {
  const sections = [
    result.diff === "" ? "" : renderDiff(result.diff, paint),
    renderNotes(result, paint),
    renderSuggestions(result.path, result.commentSuggestions, paint),
  ];
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
    [
      `  line ${suggestion.line}:`,
      ...markLines("-", suggestion.original).map((line) => paint("red", line)),
      ...markLines("+", suggestion.suggested).map((line) =>
        paint("green", line),
      ),
      `    why: ${suggestion.reason}`,
    ].join("\n"),
  );
  return `${[heading, ...items].join("\n")}\n`;
}

/** Indents each line of a (possibly multi-line) comment behind a diff marker. */
function markLines(marker: string, text: string): string[] {
  return text
    .trim()
    .split("\n")
    .map((line) => `    ${marker} ${line.trimEnd()}`);
}

/** Skipped paths grouped under their reason, long groups shortened. */
export function renderSkips(skips: readonly Skip[], paint: Paint): string {
  if (skips.length === 0) return "";
  const heading = paint("bold", `Skipped ${countOf(skips.length, "path")}:`);
  return renderGrouped(heading, skips);
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
  return renderGrouped(heading, failures);
}

function renderGrouped(heading: string, skips: readonly Skip[]): string {
  const byReason = new Map<string, string[]>();
  for (const skip of skips) {
    byReason.set(skip.reason, [
      ...(byReason.get(skip.reason) ?? []),
      skip.path,
    ]);
  }
  const lines = [heading];
  for (const [reason, paths] of byReason) {
    lines.push(`  ${reason}:`);
    lines.push(
      ...paths.slice(0, MAX_PATHS_PER_REASON).map((path) => `    ${path}`),
    );
    if (paths.length > MAX_PATHS_PER_REASON) {
      lines.push(`    ...and ${paths.length - MAX_PATHS_PER_REASON} more`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export interface CheckSummary {
  changed: number;
  unchanged: number;
  skipped: number;
  failed: number;
  suggestions: number;
}

export function renderSummary(summary: CheckSummary, paint: Paint): string {
  const parts = [
    `${countOf(summary.changed, "file")} would change`,
    `${summary.unchanged} unchanged`,
    `${summary.skipped} skipped`,
  ];
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (summary.suggestions > 0) {
    parts.push(`${countOf(summary.suggestions, "comment suggestion")}`);
  }
  const line = `${parts.join(", ")}.`;
  return `${summary.changed > 0 ? paint("bold", line) : line}\n`;
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
