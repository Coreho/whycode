// Saved review plans: `whycode check --save-plan` records the AI's validated
// comment plan for each file, and `whycode fix --plan` applies exactly those
// plans later with no model request. A plan holds the replies and hashes
// (source, request, config, tool, result fingerprint), never a copy of the
// source; replaying refuses if anything that shaped the reviewed result
// changed. Its hashing helpers are shared with the opt-in review state.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type {
  AIRequest,
  CollectedFile,
  CommentPlan,
  ConfigOverrides,
  PipelineDeps,
  WhycodeConfig,
} from "@whycode/core";
import {
  captureCommentRequest,
  commentPlanSchema,
  configSchema,
  processWithReply,
  parseCommentPlan,
  readSourceFile,
  resultFingerprint,
} from "@whycode/core";
import type { FileOutcome, PreparedRun } from "./run.js";
import { processCollectedFile } from "./run.js";

/** SHA-256 hex of a string. */
export const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** Identifies the effective configuration (defaults applied). */
export const configDigest = (config: WhycodeConfig): string =>
  digest(JSON.stringify(configSchema.parse(config)));
/**
 * Identifies this build of WhyCode. In the distributed CLI this hashes the
 * whole bundle (core, prompts and parsers), so any new version invalidates
 * saved plans and review state.
 */
export async function toolIdentity(): Promise<string> {
  return digest(await readFile(new URL(import.meta.url), "utf8"));
}

export interface SavedFile {
  path: string;
  sourceHash: string;
  requestHash: string;
  fingerprint: string;
  reply: CommentPlan;
}

export interface SavedPlan {
  schema: 1;
  tool: string;
  rootHash: string;
  configHash: string;
  overrides: ConfigOverrides;
  files: SavedFile[];
}

/**
 * Processes one file with the real provider, recording the validated reply
 * and the hashes needed to replay it. Skipped files get no entry.
 */
export async function capturePlanFile(
  file: CollectedFile,
  config: WhycodeConfig,
  deps: PipelineDeps,
): Promise<{ outcome: FileOutcome; entry?: SavedFile }> {
  let reply: string | undefined;
  let request: AIRequest | undefined;
  const outcome = await processCollectedFile(file, config, {
    ...deps,
    provider: {
      name: deps.provider.name,
      complete: async (input) => {
        request = input;
        reply = await deps.provider.complete(input);
        return reply;
      },
    },
  });
  if (
    !("result" in outcome) ||
    outcome.result.status === "skipped" ||
    reply === undefined ||
    request === undefined
  )
    return { outcome };
  // Retain only the validated structured response, not transport metadata.
  const parsed = parseCommentPlan(reply);
  if (!parsed.ok) throw new Error(parsed.error);
  // A corrective retry has extra instructions; replay uses the ordinary initial request.
  const source = {
    path: file.path,
    absolutePath: file.absolutePath,
    code: outcome.result.originalCode,
  };
  const initial = await captureCommentRequest(source, config, deps.adapters);
  if (!initial.ok)
    throw new Error(
      `${file.path}: could not capture the saved review context.`,
    );
  return {
    outcome,
    entry: {
      path: file.path,
      sourceHash: digest(outcome.result.originalCode),
      requestHash: digest(JSON.stringify(initial.request)),
      fingerprint: resultFingerprint(outcome.result),
      reply: parsed.plan,
    },
  };
}

/** Writes a new plan file (never over an existing one), readable only by you. */
export async function savePlan(
  path: string,
  run: PreparedRun,
  overrides: ConfigOverrides,
  files: SavedFile[],
): Promise<void> {
  if (files.length !== run.files.length)
    throw new Error("Plan not saved: some files could not be processed.");
  const plan: SavedPlan = {
    schema: 1,
    tool: await toolIdentity(),
    rootHash: digest(run.rootDir),
    configHash: configDigest(run.config),
    overrides,
    files,
  };
  await writeFile(path, JSON.stringify(plan, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid saved plan.");
  return value as Record<string, unknown>;
}

/** A full SHA-256 digest in hex; anything else means the plan was altered. */
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("Invalid saved plan hash.");
  return value;
}

/** Reads and strictly validates a plan file; anything unexpected is refused. */
export async function loadPlan(path: string): Promise<SavedPlan> {
  const data = object(JSON.parse(await readFile(path, "utf8")));
  if (data.schema !== 1 || !Array.isArray(data.files))
    throw new Error("Unsupported saved plan schema.");
  const names = new Set<string>();
  const files = data.files.map((value: unknown): SavedFile => {
    const item = object(value);
    const path = item.path;
    if (
      typeof path !== "string" ||
      !path ||
      isAbsolute(path) ||
      /[\\:\0]/.test(path) ||
      path
        .split("/")
        .some((part) => part === ".." || part === "." || part === "") ||
      names.has(path)
    )
      throw new Error("Invalid or duplicate path in saved plan.");
    names.add(path);
    return {
      path,
      sourceHash: hash(item.sourceHash),
      requestHash: hash(item.requestHash),
      fingerprint: hash(item.fingerprint),
      reply: commentPlanSchema.parse(item.reply),
    };
  });
  const rawOverrides = object(data.overrides);
  const validated = configSchema.partial().parse(rawOverrides);
  const overrides = Object.fromEntries(
    Object.keys(rawOverrides).map((key) => [
      key,
      validated[key as keyof typeof validated],
    ]),
  ) as ConfigOverrides;
  if (overrides.mode === "refactor")
    throw new Error("Saved plans only support safe mode.");
  return {
    schema: 1,
    tool: hash(data.tool),
    rootHash: hash(data.rootHash),
    configHash: hash(data.configHash),
    overrides,
    files,
  };
}

/**
 * Recomputes every selected file from its saved reply and checks it still
 * reproduces the reviewed result, before anything is offered or written.
 */
export async function replayPlan(
  plan: SavedPlan,
  run: PreparedRun,
  adapters: PipelineDeps["adapters"],
): Promise<FileOutcome[]> {
  if (
    plan.tool !== (await toolIdentity()) ||
    plan.rootHash !== digest(run.rootDir) ||
    plan.configHash !== configDigest(run.config)
  )
    throw new Error(
      "Saved plan tool, project, or configuration changed; generate and review a new plan.",
    );
  // Preflight every selected file before offering or writing any of them.
  const outcomes: FileOutcome[] = [];
  for (const file of run.files) {
    const entry = plan.files.find((item) => item.path === file.path);
    if (!entry)
      throw new Error(`${file.path}: not included in the saved plan.`);
    const source = await readSourceFile(file.absolutePath);
    if (!source.ok || digest(source.code) !== entry.sourceHash)
      throw new Error(
        `${file.path}: source changed since the saved plan; nothing was written.`,
      );
    const input = {
      path: file.path,
      absolutePath: resolve(file.absolutePath),
      code: source.code,
    };
    const request = await captureCommentRequest(input, run.config, adapters);
    if (
      !request.ok ||
      digest(JSON.stringify(request.request)) !== entry.requestHash
    )
      throw new Error(
        `${file.path}: prompt or formatting configuration changed; review a new plan.`,
      );
    const result = await processWithReply(
      input,
      run.config,
      adapters,
      JSON.stringify(entry.reply),
    );
    if (
      result.status === "skipped" ||
      resultFingerprint(result) !== entry.fingerprint
    )
      throw new Error(
        `${file.path}: saved plan no longer reproduces the reviewed result; nothing was written.`,
      );
    outcomes.push({ file, result });
  }
  return outcomes;
}
