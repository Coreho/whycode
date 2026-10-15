// Tests for the host-provided AI adapter: how a request becomes one prompt,
// and that the pipeline runs end to end through it.
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import { processFile } from "../pipeline.js";
import { commentAboveFirstMatch } from "../testing/scripted-replies.js";
import { createToyAdapter } from "../testing/toy-adapter.js";
import { commentPlanJsonSchema } from "./comment-plan.js";
import { createHostProvider, hostPrompt } from "./host.js";

const request = {
  system: "You write comments.",
  user: "File: a.toy (toy)\n\n1| fn main",
};

describe("hostPrompt", () => {
  it("puts the instructions first, then the request", () => {
    expect(hostPrompt(request)).toBe(
      "You write comments.\n\nFile: a.toy (toy)\n\n1| fn main",
    );
  });

  it("ends with the JSON schema the reply must match", () => {
    const prompt = hostPrompt({
      ...request,
      jsonSchema: commentPlanJsonSchema,
    });
    const [instructions, schema] = prompt.split(/JSON Schema, .*\n/);
    expect(instructions).toContain(
      "1| fn main\n\nReply with only a JSON object",
    );
    expect(JSON.parse(schema ?? "")).toEqual(commentPlanJsonSchema);
  });
});

describe("createHostProvider", () => {
  it("sends one folded prompt and returns the reply unchanged", async () => {
    const prompts: string[] = [];
    const provider = createHostProvider("host-model", (prompt) => {
      prompts.push(prompt);
      return Promise.resolve("reply text");
    });
    expect(provider.name).toBe("host-model");
    await expect(provider.complete(request)).resolves.toBe("reply text");
    expect(prompts).toEqual([hostPrompt(request)]);
  });

  it("passes the host's failures on to the pipeline", async () => {
    const provider = createHostProvider("host-model", () =>
      Promise.reject(new Error("no permission")),
    );
    await expect(provider.complete(request)).rejects.toThrow("no permission");
  });

  it("drives the pipeline, which finds the numbered code in the prompt", async () => {
    const reply = commentAboveFirstMatch(/^fn/, "Entry point.");
    const provider = createHostProvider("host-model", (prompt) =>
      Promise.resolve(reply({ system: "", user: prompt })),
    );
    const result = await processFile(
      { path: "main.toy", code: "fn main\n  run\n" },
      resolveConfig(),
      { provider, adapters: [createToyAdapter()] },
    );
    expect(result.status).toBe("changed");
    expect(result.verification).toBe("passed");
    expect(result.outputCode).toBe("# Entry point.\nfn main\n  run\n");
  });
});
