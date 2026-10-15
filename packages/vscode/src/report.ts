// Text for the WhyCode output channel and the end-of-run notification. VS
// Code keeps output channels in its log files, so code never goes there.
// Core messages can quote code (the token that changed, a formatter's syntax
// error), so each one is cut to its first line with quoted text masked.
import { redactSecrets } from "@whycode/core";

export interface Skip {
  path: string;
  reason: string;
}

/** What happened to each file in one run. */
export interface RunTally {
  written: string[];
  discarded: string[];
  unchanged: string[];
  /** Left alone because the user stopped the review. */
  notReviewed: string[];
  /** The AI's comments failed verification, so only formatting was offered. */
  formattingOnly: string[];
  /** Never sent to the AI: gitignored, sensitive, unsupported, unsaved... */
  skipped: Skip[];
  /** Processing or writing failed. */
  failed: Skip[];
}

export function emptyTally(): RunTally {
  return {
    written: [],
    discarded: [],
    unchanged: [],
    notReviewed: [],
    formattingOnly: [],
    skipped: [],
    failed: [],
  };
}

const MAX_MESSAGE_LENGTH = 300;

/** A core message made safe for the log: one line, no quoted code, no secrets. */
export function forLog(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0] ?? "";
  const masked = firstLine.replace(/"[^"]*"|`[^`]*`/g, '"..."');
  return redactSecrets(masked).code.slice(0, MAX_MESSAGE_LENGTH);
}

/** The end-of-run report, as output channel lines. */
export function renderTally(tally: RunTally): string[] {
  return [
    ...byReason(
      `Skipped ${countOf(tally.skipped.length, "path")}`,
      tally.skipped,
    ),
    ...byReason(
      `Could not process ${countOf(tally.failed.length, "file")}`,
      tally.failed,
    ),
    ...group("Written", tally.written),
    ...group("Discarded", tally.discarded),
    ...group("Not reviewed (you stopped)", tally.notReviewed),
    ...group(
      "Comments discarded because verification failed; only formatting offered",
      tally.formattingOnly,
    ),
    ...group("Unchanged", tally.unchanged),
  ];
}

/** One sentence for the notification, e.g. "2 written, 1 skipped." */
export function summarize(tally: RunTally): string {
  const counts: [number, string][] = [
    [tally.written.length, "written"],
    [tally.discarded.length, "discarded"],
    [tally.notReviewed.length, "not reviewed"],
    [tally.unchanged.length, "unchanged"],
    [tally.skipped.length, "skipped"],
    [tally.failed.length, "failed"],
  ];
  const parts = counts
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`);
  return parts.length === 0 ? "nothing to do." : `${parts.join(", ")}.`;
}

function byReason(heading: string, skips: readonly Skip[]): string[] {
  if (skips.length === 0) return [];
  const paths = new Map<string, string[]>();
  for (const { path, reason } of skips) {
    const key = forLog(reason);
    paths.set(key, [...(paths.get(key) ?? []), path]);
  }
  const lines = [`${heading}:`];
  for (const [reason, group] of paths) {
    lines.push(`  ${reason}:`, ...group.map((path) => `    ${path}`));
  }
  return lines;
}

function group(label: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  return [`${label} (${paths.length}):`, ...paths.map((path) => `  ${path}`)];
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
