// Coordinates a read-only PR run: collect approved paths, process, then post one review.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  collectFiles,
  createConfiguredProvider,
  defaultAdapters,
  loadConfig,
  processFile,
  readSourceFile,
  resolveConfig,
} from "@whycode/core";
import type {
  AIProvider,
  CollectedFile,
  LanguageAdapter,
  PipelineDeps,
  WhycodeConfig,
} from "@whycode/core";
import { reviewFile } from "./review.js";
import type { FileReview, ReviewComment } from "./review.js";

export interface PullRequest {
  owner: string;
  repo: string;
  pull_number: number;
}
export interface ChangedFile {
  filename: string;
  status: string;
  sha: string | null;
  patch?: string;
}
export interface ReviewRequest extends PullRequest {
  commit_id: string;
  event: "COMMENT";
  body: string;
  comments: ReviewComment[];
}
export interface GitHubClient {
  listFiles: (request: PullRequest) => Promise<ChangedFile[]>;
  getHead: (request: PullRequest) => Promise<string>;
  createReview: (request: ReviewRequest) => Promise<unknown>;
}
export interface ActionOptions {
  workspace: string;
  eventName: string;
  payload: unknown;
  repo: { owner: string; repo: string };
  inputs: { apiKey?: string; commentLevel?: string; model?: string };
  env: NodeJS.ProcessEnv;
  github: GitHubClient;
  maskSecret: (value: string) => void;
  provider?: AIProvider;
  adapters?: readonly LanguageAdapter[];
  readHead?: () => Promise<string>;
}

/** Treat webhook contents as data; never derive a command from the PR. */
function pullRequest(payload: unknown): { number: number; sha: string } {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "pull_request" in payload
  ) {
    const pr = payload.pull_request;
    if (
      typeof pr === "object" &&
      pr !== null &&
      "number" in pr &&
      typeof pr.number === "number" &&
      "head" in pr
    ) {
      const head = pr.head;
      if (
        typeof head === "object" &&
        head !== null &&
        "sha" in head &&
        typeof head.sha === "string"
      )
        return { number: pr.number, sha: head.sha };
    }
  }
  throw new Error("A pull_request payload with a head SHA is required.");
}

/** Escapes untrusted paths/reasons so summary text cannot create mentions or markup. */
function summaryText(text: string): string {
  return text
    .replace(/[&<>@`*_[\]\\]/g, (char) => `&#${char.charCodeAt(0)};`)
    .replace(/[\r\n]/g, " ");
}

async function previewFile(
  file: CollectedFile,
  metadata: ChangedFile,
  config: WhycodeConfig,
  deps: PipelineDeps,
): Promise<FileReview> {
  const skipped = (reason: string): FileReview => ({
    comments: [],
    notes: [reason],
  });
  try {
    const source = await readSourceFile(file.absolutePath);
    if (!source.ok) return skipped(`skipped — ${source.reason}`);
    const hash = createHash("sha1")
      .update(`blob ${Buffer.byteLength(source.code)}\0${source.code}`)
      .digest("hex");
    if (hash !== metadata.sha)
      return skipped(
        "skipped — workspace content does not match the PR head blob",
      );
    const result = await processFile(
      { ...file, code: source.code },
      config,
      deps,
    );
    return await reviewFile(result, metadata.patch, deps.adapters);
  } catch {
    // Exception details may contain source text or credentials; keep the review safe.
    return skipped("processing failed; no suggestions posted");
  }
}

/** Bounds GitHub payloads and records every withheld preview rather than dropping it. */
function appendReview(
  path: string,
  review: FileReview,
  comments: ReviewComment[],
  notes: string[],
  redact: (text: string) => string,
): void {
  let added = 0;
  let limited = 0;
  for (const comment of review.comments) {
    if (redact(comment.body) !== comment.body) {
      review.notes.push(
        "suggestion withheld because it contains an API secret",
      );
    } else if (
      comments.length >= 50 ||
      Buffer.byteLength(comment.body) > 60000
    ) {
      limited++;
    } else {
      comments.push(comment);
      added++;
    }
  }
  if (added) notes.push(`${path}: ${added} suggestion(s)`);
  if (limited)
    review.notes.push(
      `${limited} suggestion(s) withheld by review size limits`,
    );
  notes.push(...review.notes.map((note) => `${path}: ${note}`));
}

function summaryBody(
  notes: string[],
  redact: (text: string) => string,
): string {
  let body =
    "WhyCode preview — apply each suggestion individually. No branch files were written.\n\n";
  let omitted = 0;
  for (const note of notes) {
    const line = `- ${summaryText(redact(note))}\n`;
    if (Buffer.byteLength(body + line) > 59000) omitted++;
    else body += line;
  }
  if (omitted)
    body += `\n${omitted} additional summary entries omitted by review size limits.\n`;
  return body;
}

export async function runAction(options: ActionOptions): Promise<void> {
  if (options.eventName !== "pull_request") return;
  const { inputs, env, github, workspace } = options;
  const secrets = [inputs.apiKey, env.ANTHROPIC_API_KEY].filter(
    (value): value is string => Boolean(value),
  );
  for (const secret of secrets) options.maskSecret(secret);
  const apiKey = inputs.apiKey || env.ANTHROPIC_API_KEY;
  if (!apiKey?.trim())
    throw new Error(
      "Set anthropic-api-key from a repository secret or ANTHROPIC_API_KEY.",
    );
  const redact = (text: string) =>
    secrets.reduce(
      (safe, secret) => safe.replaceAll(secret, "[REDACTED]"),
      text,
    );
  const pr = pullRequest(options.payload);
  const request = { ...options.repo, pull_number: pr.number };
  const readHead =
    options.readHead ??
    (async () =>
      (
        await promisify(execFile)("git", ["rev-parse", "HEAD"], {
          cwd: workspace,
        })
      ).stdout.trim());
  if (
    (await readHead()) !== pr.sha ||
    (await github.getHead(request)) !== pr.sha
  )
    throw new Error(
      "Checkout must match the current PR head SHA; use actions/checkout with github.event.pull_request.head.sha.",
    );
  // This front-end always previews safe-mode work and never runs repository test commands.
  const config = await loadConfig(workspace, {
    mode: "safe",
    provider: "anthropic",
    testCommand: null,
    ...(inputs.commentLevel
      ? {
          commentLevel: resolveConfig({ commentLevel: inputs.commentLevel })
            .commentLevel,
        }
      : {}),
    ...(inputs.model ? { model: inputs.model } : {}),
  });
  const provider =
    options.provider ??
    createConfiguredProvider(config, { env: { ANTHROPIC_API_KEY: apiKey } });
  const adapters = options.adapters ?? defaultAdapters;
  const changed = await github.listFiles(request);
  // GitHub caps this endpoint at 3,000 files; never claim a complete larger review.
  if (changed.length >= 3000)
    throw new Error(
      "PR files API reached its 3,000-file limit; split the PR before reviewing.",
    );
  const paths = changed.filter((file) => file.status !== "removed");
  const collection = await collectFiles({
    rootDir: workspace,
    cwd: workspace,
    paths: paths.map((file) => file.filename),
    config,
    adapters,
  });
  const byPath = new Map(paths.map((file) => [file.filename, file]));
  const notes = collection.skipped.map(
    (file) => `${file.path}: skipped — ${file.reason}`,
  );
  notes.push(
    ...changed
      .filter((file) => file.status === "removed")
      .map((file) => `${file.filename}: skipped — removed`),
  );
  const comments: ReviewComment[] = [];
  for (const file of collection.files) {
    // Do not process directory descendants absent from the API's exact file list.
    const metadata = byPath.get(file.path);
    if (!metadata) continue;
    const review = await previewFile(file, metadata, config, {
      provider,
      adapters,
    });
    appendReview(file.path, review, comments, notes, redact);
  }
  if (!notes.length && !comments.length) return;
  if ((await github.getHead(request)) !== pr.sha)
    throw new Error("PR head advanced during processing; rerun WhyCode.");
  await github.createReview({
    ...request,
    commit_id: pr.sha,
    event: "COMMENT",
    body: summaryBody(notes, redact),
    comments,
  });
}
