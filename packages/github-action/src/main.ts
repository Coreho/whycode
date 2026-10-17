// GitHub runtime edge: reads masked inputs and adapts Octokit to the offline runner.
import * as core from "@actions/core";
import * as github from "@actions/github";
import { redactSecrets, useGrammarDirectory } from "@whycode/core";
import { join } from "node:path";
import { runAction } from "./run.js";
import type { GitHubClient } from "./run.js";

/** Pagination and posting stay at the network edge, away from mapping logic. */
export function githubClient(
  octokit: ReturnType<typeof github.getOctokit>,
): GitHubClient {
  return {
    listFiles: (request) =>
      octokit.paginate(octokit.rest.pulls.listFiles, {
        ...request,
        per_page: 100,
      }),
    getHead: async (request) =>
      (await octokit.rest.pulls.get({ ...request })).data.head.sha,
    createReview: (request) => octokit.rest.pulls.createReview({ ...request }),
  };
}

export async function main(): Promise<void> {
  if (github.context.eventName !== "pull_request") {
    core.info("WhyCode runs only on pull_request events.");
    return;
  }
  const apiKey = core.getInput("anthropic-api-key");
  const token = core.getInput("github-token") || process.env.GITHUB_TOKEN || "";
  for (const secret of [apiKey, process.env.ANTHROPIC_API_KEY, token])
    if (secret) core.setSecret(secret);
  try {
    if (!token)
      throw new Error("A github-token with pull-requests: write is required.");
    useGrammarDirectory(join(__dirname, "grammars"));
    await runAction({
      workspace: process.env.GITHUB_WORKSPACE || process.cwd(),
      eventName: github.context.eventName,
      payload: github.context.payload,
      repo: github.context.repo,
      env: process.env,
      inputs: {
        apiKey,
        commentLevel: core.getInput("comment-level"),
        model: core.getInput("model"),
      },
      github: githubClient(github.getOctokit(token)),
      maskSecret: core.setSecret,
      // Outside a runner (or on older ones) there is no job summary to write.
      writeSummary: process.env.GITHUB_STEP_SUMMARY
        ? async (markdown) => {
            await core.summary.addRaw(markdown).write();
          }
        : undefined,
    });
  } catch (error) {
    // The message says what to fix (e.g. a missing key). Registered secrets
    // are masked in the log already; likely secrets in it are masked too.
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(
      `WhyCode could not complete the review: ${redactSecrets(message).code} Check the secret inputs, .whycoderc.json, the PR head checkout, and the token's pull-requests permission.`,
    );
  }
}
