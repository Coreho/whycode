// Commands for AI agents whose own model does WhyCode's AI step, such as the
// Claude Code plugin. `prompt` prints the requests WhyCode would send,
// `preview` runs a file through the pipeline with the agent's reply and shows
// the diff, and `write` writes that same result once the person approved it.
// The fingerprint from `preview` guarantees `write` writes exactly what was
// shown. Privacy rules, verification and suggestion checks are the core's,
// unchanged.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AIRequest,
  CollectedFile,
  ConfigOverrides,
  FileResult,
} from "@whycode/core";
import {
  applyCommentSuggestions,
  captureCommentRequest,
  fileVerdict,
  processWithReply,
  readSourceFile,
  resultFingerprint,
  writeSourceFile,
} from "@whycode/core";
import type { CliIo } from "./io.js";
import type { Skip } from "./report.js";
import {
  painter,
  renderPreview,
  renderSuggestion,
  renderVerdict,
} from "./report.js";
import type { CommandDeps, PreparedRun } from "./run.js";
import { EXIT_CODES, prepareRun } from "./run.js";

/** Agent commands always run safe mode: the agent's reply is a comment plan. */
const SAFE = { mode: "safe" } as const;

export interface PromptRequest {
  paths: readonly string[];
  overrides: ConfigOverrides;
  /** Only list the files, so an agent can then ask for one file at a time. */
  list: boolean;
}

export async function runPrompt(
  request: PromptRequest,
  io: CliIo,
  deps: CommandDeps,
): Promise<number> {
  const overrides = { ...request.overrides, ...SAFE };
  const run = await prepareRun(request.paths, overrides, io, deps);
  if (run === undefined) return EXIT_CODES.error;
  if (request.list) {
    io.stdout(renderFileList(run));
    return EXIT_CODES.clean;
  }
  const requests: { path: string; request: AIRequest }[] = [];
  const failures: Skip[] = [];
  for (const file of run.files) {
    const captured = await captureFile(file, run, deps);
    if (captured.ok)
      requests.push({ path: file.path, request: captured.request });
    else failures.push({ path: file.path, reason: captured.reason });
  }
  io.stdout(renderRequests(requests, run, failures));
  return failures.length > 0 ? EXIT_CODES.error : EXIT_CODES.clean;
}

async function captureFile(
  file: CollectedFile,
  run: PreparedRun,
  deps: CommandDeps,
): Promise<{ ok: true; request: AIRequest } | { ok: false; reason: string }> {
  const source = await readSourceFile(file.absolutePath);
  if (!source.ok) return { ok: false, reason: source.reason };
  const input = {
    path: file.path,
    absolutePath: file.absolutePath,
    code: source.code,
  };
  return captureCommentRequest(input, run.config, deps.adapters);
}

function renderRequests(
  requests: readonly { path: string; request: AIRequest }[],
  run: PreparedRun,
  failures: readonly Skip[],
): string {
  const sections = [
    `WhyCode comment requests for ${requests.length} file(s) (comment level: ${run.config.commentLevel}).`,
    `For each file, write one JSON comment plan that follows the system prompt and matches the schema, then run: whycode preview <file> --plan <plan file, or - for stdin>`,
  ];
  const first = requests[0]?.request;
  if (first !== undefined) {
    sections.push(
      `===== SYSTEM PROMPT (the same for every file) =====\n${first.system}`,
    );
    sections.push(
      `===== REPLY SCHEMA (JSON Schema) =====\n${JSON.stringify(first.jsonSchema ?? {})}`,
    );
  }
  for (const { path, request } of requests) {
    // The system prompt depends only on the comment level; say so if not.
    const system =
      first !== undefined && request.system !== first.system
        ? `\n----- system prompt for this file -----\n${request.system}`
        : "";
    sections.push(`===== FILE: ${path} =====${system}\n${request.user}`);
  }
  sections.push(renderPathList("SKIPPED (never read)", run.skips));
  sections.push(renderPathList("COULD NOT PREPARE", failures));
  return `${sections.filter((section) => section !== "").join("\n\n")}\n`;
}

function renderFileList(run: PreparedRun): string {
  const heading = `===== FILES WhyCode would process (${run.files.length}) =====`;
  const sections = [
    [heading, ...run.files.map((file) => file.path)].join("\n"),
    renderPathList("SKIPPED (never read)", run.skips),
  ];
  return `${sections.filter((section) => section !== "").join("\n\n")}\n`;
}

function renderPathList(title: string, entries: readonly Skip[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map(({ path, reason }) => `${path}: ${reason}`);
  return [`===== ${title} =====`, ...lines].join("\n");
}

/** One file and the agent's plan for it, as preview and write receive them. */
export interface AgentStep {
  path: string;
  plan: string;
  /** Only the format setting, which must match the prompt's. */
  overrides: ConfigOverrides;
}

export async function runPreview(
  step: AgentStep,
  io: CliIo,
  deps: CommandDeps,
): Promise<number> {
  const outcome = await processWithPlan(step, io, deps);
  if (outcome === undefined) return EXIT_CODES.error;
  const { result } = outcome;
  const paint = painter(io.color);
  if (result.status === "unchanged" && result.commentSuggestions.length === 0) {
    // Nothing to write, but say why: the comments may have been discarded.
    const notes = renderPreview(result, paint);
    io.stdout(renderVerdict(result.path, fileVerdict(result), paint));
    io.stdout(`${notes}Nothing to write for ${result.path}.\n`);
    return EXIT_CODES.clean;
  }
  io.stdout(renderAgentPreview(result, paint));
  return EXIT_CODES.clean;
}

function renderAgentPreview(
  result: FileResult,
  paint: ReturnType<typeof painter>,
): string {
  const total = result.commentSuggestions.length;
  const suggestions = result.commentSuggestions.map((suggestion, index) =>
    renderSuggestion(
      result.path,
      suggestion,
      { index: index + 1, total },
      paint,
    ),
  );
  const fingerprint = resultFingerprint(result);
  const accept = total > 0 ? " [--accept-suggestions <numbers, e.g. 1,3>]" : "";
  return [
    renderVerdict(result.path, fileVerdict(result), paint).trimEnd(),
    renderPreview(result, paint),
    ...suggestions,
    `Fingerprint: ${fingerprint}`,
    `After the user approves, write it with: whycode write ${result.path} --plan <the same plan> --fingerprint ${fingerprint}${accept}`,
  ]
    .filter((section) => section !== "")
    .join("\n")
    .concat("\n");
}

export interface WriteRequest extends AgentStep {
  fingerprint: string;
  acceptSuggestions: readonly number[];
}

export async function runWrite(
  request: WriteRequest,
  io: CliIo,
  deps: CommandDeps,
): Promise<number> {
  const outcome = await processWithPlan(request, io, deps);
  if (outcome === undefined) return EXIT_CODES.error;
  const { result, file } = outcome;
  if (resultFingerprint(result) !== request.fingerprint) {
    return fail(
      io,
      `${result.path} or the plan changed since the preview, so nothing was written. Run "whycode preview" again.`,
    );
  }
  const suggestions = result.commentSuggestions;
  const outOfRange = request.acceptSuggestions.find(
    (n) => n > suggestions.length,
  );
  if (outOfRange !== undefined) {
    return fail(
      io,
      `there is no suggestion ${outOfRange}; the preview listed ${suggestions.length}.`,
    );
  }
  const accepted = request.acceptSuggestions.flatMap(
    (n) => suggestions[n - 1] ?? [],
  );
  const applied = await applyCommentSuggestions(
    result.path,
    result.outputCode,
    accepted,
    deps.adapters,
  );
  for (const { suggestion, reason } of applied.notApplied) {
    io.stdout(
      `Did not apply the suggestion for line ${suggestion.line}: ${reason}.\n`,
    );
  }
  if (applied.code === result.originalCode) {
    io.stdout(`Nothing to write for ${result.path}.\n`);
    return EXIT_CODES.clean;
  }
  const written = await writeSourceFile(
    file.absolutePath,
    applied.code,
    result.originalCode,
  );
  if (!written.ok)
    return fail(io, `${result.path} was not written: ${written.reason}.`);
  io.stdout(
    `Wrote ${result.path} (${applied.applied.length} comment suggestion(s) applied).\n`,
  );
  return EXIT_CODES.clean;
}

/** Collects the one file (privacy rules apply), reads the plan and runs the pipeline. */
async function processWithPlan(
  { path, plan: planSource, overrides }: AgentStep,
  io: CliIo,
  deps: CommandDeps,
): Promise<{ result: FileResult; file: CollectedFile } | undefined> {
  const run = await prepareRun([path], { ...overrides, ...SAFE }, io, deps);
  if (run === undefined) return undefined;
  const [file] = run.files;
  if (file === undefined) {
    const reason = run.skips[0]?.reason ?? "it was not collected";
    fail(io, `${path} can't be processed: ${reason}.`);
    return undefined;
  }
  const source = await readSourceFile(file.absolutePath);
  if (!source.ok) {
    fail(io, `${file.path} ${source.reason}.`);
    return undefined;
  }
  const plan =
    planSource === "-"
      ? await io.readStdin()
      : await readFile(resolve(io.cwd, planSource), "utf8");
  const input = {
    path: file.path,
    absolutePath: file.absolutePath,
    code: source.code,
  };
  const result = await processWithReply(input, run.config, deps.adapters, plan);
  if (result.status === "skipped") {
    fail(
      io,
      `${file.path} could not be processed: ${result.skipReason ?? "unknown error"}`,
    );
    return undefined;
  }
  return { result, file };
}

function fail(io: CliIo, message: string): number {
  io.stderr(`whycode: ${message}\n`);
  return EXIT_CODES.error;
}
