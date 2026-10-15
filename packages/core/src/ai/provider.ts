// The one interface every AI backend implements (Claude API, host-provided
// models, test fakes). The pipeline only ever talks to an AIProvider.

export interface AIRequest {
  system: string;
  user: string;
  /** JSON Schema the response must match, for providers that can enforce it. */
  jsonSchema?: Record<string, unknown>;
}

export interface AIProvider {
  name: string;
  /** Sends one request and resolves with the model's raw text reply. */
  complete(request: AIRequest): Promise<string>;
}
