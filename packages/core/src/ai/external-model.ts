// Lets a model outside WhyCode do the AI step, for hosts such as Claude Code
// whose model can't be called through an API. First capture the request
// WhyCode would send for a file; later run the pipeline again with the
// model's reply. The pipeline is deterministic up to the AI call, so both
// runs see the same formatted code and line numbers, and the reply goes
// through the usual validation, insertion and logic-unchanged check.
import { createHash } from "node:crypto";
import type { WhycodeConfig } from "../config.js";
import type { LanguageAdapter } from "../languages/adapter.js";
import type { FileInput, FileResult } from "../pipeline.js";
import { processFile } from "../pipeline.js";
import type { AIProvider, AIRequest } from "./provider.js";

export type CapturedRequest =
  { ok: true; request: AIRequest } | { ok: false; reason: string };

/** Stops the pipeline at the AI call once the request has been recorded. */
class RequestCaptured extends Error {}

/** The request WhyCode would send to an AI for this file, in safe mode. */
export async function captureCommentRequest(
  input: FileInput,
  config: WhycodeConfig,
  adapters: readonly LanguageAdapter[],
): Promise<CapturedRequest> {
  let captured: AIRequest | undefined;
  const capturing: AIProvider = {
    name: "capture",
    complete(request) {
      captured ??= request;
      return Promise.reject(new RequestCaptured());
    },
  };
  const result = await processFile(input, safeMode(config), {
    provider: capturing,
    adapters,
  });
  if (captured !== undefined) return { ok: true, request: captured };
  return { ok: false, reason: result.skipReason ?? "it needs no AI step" };
}

/** Runs the pipeline in safe mode with `reply` as the AI's answer. */
export function processWithReply(
  input: FileInput,
  config: WhycodeConfig,
  adapters: readonly LanguageAdapter[],
  reply: string,
): Promise<FileResult> {
  const replying: AIProvider = {
    name: "external model",
    complete: () => Promise.resolve(reply),
  };
  return processFile(input, safeMode(config), { provider: replying, adapters });
}

/**
 * Identifies one preview: the file as read and everything shown about it,
 * including each suggested comment rewrite in order. Writing later with the
 * same fingerprint guarantees the person approved exactly what is written,
 * and that an accepted suggestion number still means the same suggestion.
 */
export function resultFingerprint(result: FileResult): string {
  const shown = {
    path: result.path,
    originalCode: result.originalCode,
    outputCode: result.outputCode,
    mode: result.mode,
    verification: result.verification,
    warnings: result.warnings,
    suggestions: result.commentSuggestions.map((suggestion) => [
      suggestion.line,
      suggestion.original,
      suggestion.suggested,
      suggestion.reason,
    ]),
  };
  return createHash("sha256")
    .update(JSON.stringify(shown))
    .digest("hex")
    .slice(0, 16);
}

function safeMode(config: WhycodeConfig): WhycodeConfig {
  return { ...config, mode: "safe" };
}
