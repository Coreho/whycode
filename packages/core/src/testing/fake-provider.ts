// Scripted AIProvider for tests and offline runs. It replies with canned
// responses in order (the last one repeats) and records every request.
import type { CommentPlan } from "../ai/comment-plan.js";
import type { AIProvider, AIRequest } from "../ai/provider.js";

/** A reply string, an error to reject with, or a function computing the reply. */
export type FakeResponse = string | Error | ((request: AIRequest) => string);

export class FakeAIProvider implements AIProvider {
  readonly name = "fake";
  readonly requests: AIRequest[] = [];
  private readonly responses: readonly FakeResponse[];

  constructor(responses: FakeResponse | readonly FakeResponse[]) {
    this.responses = isResponseList(responses) ? [...responses] : [responses];
  }

  complete(request: AIRequest): Promise<string> {
    this.requests.push(request);
    const index = Math.min(this.requests.length, this.responses.length) - 1;
    const response = this.responses[index];
    if (response === undefined) {
      return Promise.reject(
        new Error("FakeAIProvider has no scripted responses."),
      );
    }
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(
      typeof response === "function" ? response(request) : response,
    );
  }
}

// Array.isArray narrows a readonly array to any[], so wrap it in a typed guard.
function isResponseList(
  value: FakeResponse | readonly FakeResponse[],
): value is readonly FakeResponse[] {
  return Array.isArray(value);
}

/** Serializes a comment plan the way a well-behaved model would reply. */
export function commentPlanReply(plan: Partial<CommentPlan>): string {
  return JSON.stringify({
    insertions: plan.insertions ?? [],
    existingCommentSuggestions: plan.existingCommentSuggestions ?? [],
  });
}
