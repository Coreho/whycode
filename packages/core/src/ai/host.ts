// Adapter for AI that a host application provides, such as the VS Code
// Language Model API or Claude Code. A host chat model takes one prompt and
// returns text: it may have no system role and no way to enforce a JSON
// schema. So the system prompt and the schema are folded into that one
// prompt, and the pipeline still validates every reply (retrying once).
import type { AIProvider, AIRequest } from "./provider.js";

/** Sends one prompt to the host's model and resolves with its whole text reply. */
export type SendPrompt = (prompt: string) => Promise<string>;

export function createHostProvider(
  name: string,
  sendPrompt: SendPrompt,
): AIProvider {
  return {
    name,
    complete: (request) => sendPrompt(hostPrompt(request)),
  };
}

/**
 * The single prompt for a request: the instructions, then the file, then the
 * reply format. The format comes last because chat models follow it most
 * reliably there.
 */
export function hostPrompt(request: AIRequest): string {
  const parts = [request.system, request.user];
  if (request.jsonSchema !== undefined) {
    parts.push(
      `Reply with only a JSON object that matches this JSON Schema, with no Markdown code fence and no other text:\n${JSON.stringify(request.jsonSchema)}`,
    );
  }
  return parts.join("\n\n");
}
