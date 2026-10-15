// Executes the copied CJS bundle with fake API edges and real Python/TypeScript parsing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
// The path exists only in the isolated copy; the type describes its public test entry.
const bundled = /** @type {typeof import('../src/internal.js')} */ (
  require("./dist/internal.cjs")
);
const root = process.cwd();
const files = [
  { filename: "sample.py", code: "def twice(value):\n    return value * 2\n" },
  {
    filename: "sample.ts",
    code: "function twice(value:number){return value*2}\n",
  },
];
for (const file of files) await writeFile(join(root, file.filename), file.code);
let requests = 0;
const provider = {
  name: "offline-fake",
  complete: () => {
    requests++;
    return Promise.resolve(
      JSON.stringify({
        insertions: [
          { line: 1, position: "above", text: "Double the value for callers." },
        ],
        existingCommentSuggestions: [],
      }),
    );
  },
};
/** @type {import('../src/run.js').ReviewRequest[]} */
const reviews = [];
const listFiles = () =>
  Promise.resolve(
    files.map((file) => ({
      filename: file.filename,
      status: "modified",
      sha: createHash("sha1")
        .update(`blob ${Buffer.byteLength(file.code)}\0${file.code}`)
        .digest("hex"),
      patch: `@@ -1 +1,${file.code.split("\n").length - 1} @@\n-old\n${file.code
        .trimEnd()
        .split("\n")
        .map((line) => `+${line}`)
        .join("\n")}\n`,
    })),
  );
let paginated = false;
const fakeOctokit = {
  paginate: (
    /** @type {unknown} */ method,
    /** @type {{per_page: number}} */ request,
  ) => {
    assert.equal(method, listFiles);
    assert.equal(request.per_page, 100);
    paginated = true;
    return listFiles();
  },
  rest: {
    pulls: {
      listFiles,
      get: () => Promise.resolve({ data: { head: { sha: "offline-head" } } }),
      createReview: (
        /** @type {import('../src/run.js').ReviewRequest} */ review,
      ) => {
        reviews.push(review);
        return Promise.resolve({});
      },
    },
  },
};
bundled.initializeGrammars();
// The fake implements only the SDK methods used by the adapter.
const client = bundled.githubClient(
  /** @type {Parameters<typeof bundled.githubClient>[0]} */ (
    /** @type {unknown} */ (fakeOctokit)
  ),
);
await bundled.runAction({
  workspace: root,
  eventName: "pull_request",
  payload: JSON.parse(
    await readFile(process.env.GITHUB_EVENT_PATH ?? "", "utf8"),
  ),
  repo: { owner: "offline", repo: "repo" },
  inputs: {},
  env: { ANTHROPIC_API_KEY: "offline-placeholder" },
  github: client,
  provider,
  maskSecret: () => {},
  readHead: () => Promise.resolve("offline-head"),
});
assert.equal(requests, 2);
assert.equal(paginated, true);
assert.equal(reviews.length, 1);
for (const file of files) {
  assert.equal(await readFile(join(root, file.filename), "utf8"), file.code);
  assert(
    reviews[0]?.comments.some(
      (comment) =>
        comment.path === file.filename && comment.body.includes("suggestion"),
    ),
    JSON.stringify(reviews),
  );
}
// Prove real WASM tokenization, separately from any processing fallback.
for (const extension of [".py", ".ts"]) {
  const adapter = bundled.defaultAdapters.find((adapter) =>
    adapter.extensions.includes(extension),
  );
  assert(adapter);
  const code = extension === ".py" ? "value = 1\n" : "const value = 1;\n";
  assert((await adapter.tokens(code)).length > 0);
}
process.stdout.write(
  "Standalone action verified: Python/TypeScript WASM, Prettier, fake paginated GitHub review, and unchanged source files.\n",
);
