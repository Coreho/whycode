// Tests for file collection: directory walks, config globs, and the privacy
// rules (.gitignore and secret files are never collected, only reported).
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAdapters } from "../languages/index.js";
import type { CollectOptions, FileCollection } from "./collect.js";
import { collectFiles } from "./collect.js";

const defaultGlobs = {
  include: ["**/*"],
  exclude: ["node_modules/**", "dist/**"],
};

describe("collectFiles", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "whycode-collect-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function files(entries: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(entries)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
  }

  function collect(
    paths: string[],
    options: Partial<CollectOptions> = {},
  ): Promise<FileCollection> {
    return collectFiles({
      rootDir: root,
      cwd: root,
      paths,
      config: defaultGlobs,
      adapters: defaultAdapters,
      ...options,
    });
  }

  const pathsOf = (collection: FileCollection) =>
    collection.files.map((file) => file.path);
  const skipsOf = (collection: FileCollection) =>
    collection.skipped.map(({ path, kind }) => ({ path, kind }));

  it("walks directories in name order and keeps only supported languages", async () => {
    await files({
      "src/b.py": "",
      "src/a.ts": "",
      "src/nested/c.go": "",
      "src/notes.md": "",
      "src/script.rb": "",
      "README.md": "",
    });
    const result = await collect(["."]);
    expect(pathsOf(result)).toEqual([
      "src/a.ts",
      "src/b.py",
      "src/nested/c.go",
      "src/script.rb",
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.files[0]?.absolutePath).toBe(join(root, "src", "a.ts"));
  });

  it("resolves paths against cwd and reports them relative to the root", async () => {
    await files({ "src/app/main.py": "", "src/app/util.py": "" });
    const result = await collect(["main.py", "."], {
      cwd: join(root, "src", "app"),
    });
    expect(pathsOf(result)).toEqual(["src/app/main.py", "src/app/util.py"]);
  });

  it("never collects gitignored files and reports ignored directories once", async () => {
    await files({
      ".gitignore": "build/\n*.generated.ts\n",
      "build/out.py": "",
      "build/deep/more.py": "",
      "src/api.generated.ts": "",
      "src/api.ts": "",
    });
    const result = await collect(["."]);
    expect(pathsOf(result)).toEqual(["src/api.ts"]);
    expect(skipsOf(result)).toEqual([
      { path: "build/", kind: "gitignored" },
      { path: "src/api.generated.ts", kind: "gitignored" },
    ]);
  });

  it("applies nested .gitignore files, deeper rules winning", async () => {
    await files({
      ".gitignore": "*.gen.py\n",
      "pkg/.gitignore": "!keep.gen.py\nlocal.py\n",
      "pkg/keep.gen.py": "",
      "pkg/drop.gen.py": "",
      "pkg/local.py": "",
      "local.py": "",
    });
    const result = await collect(["."]);
    expect(pathsOf(result)).toEqual(["local.py", "pkg/keep.gen.py"]);
    expect(skipsOf(result)).toEqual([
      { path: "pkg/drop.gen.py", kind: "gitignored" },
      { path: "pkg/local.py", kind: "gitignored" },
    ]);
  });

  it("honors .git/info/exclude", async () => {
    await files({
      ".git/info/exclude": "scratch.py\n",
      "scratch.py": "",
      "app.py": "",
    });
    const result = await collect(["."]);
    expect(pathsOf(result)).toEqual(["app.py"]);
    expect(skipsOf(result)).toEqual([
      { path: "scratch.py", kind: "gitignored" },
    ]);
  });

  it("refuses files the user names explicitly if git ignores them", async () => {
    await files({ ".gitignore": "out/\n", "out/gen.py": "" });
    const result = await collect(["out/gen.py", "out"]);
    expect(result.files).toEqual([]);
    expect(skipsOf(result)).toEqual([
      { path: "out/gen.py", kind: "gitignored" },
      { path: "out/", kind: "gitignored" },
    ]);
  });

  it("can't re-include a file inside an ignored directory, like git", async () => {
    await files({
      ".gitignore": "vendor/\n!vendor/lib.py\n",
      "vendor/lib.py": "",
    });
    const result = await collect(["vendor/lib.py"]);
    expect(skipsOf(result)).toEqual([
      { path: "vendor/lib.py", kind: "gitignored" },
    ]);
  });

  it("never collects secret files, even when named explicitly or gitignored", async () => {
    await files({
      ".gitignore": ".env\n",
      ".env": "TOKEN=x",
      "certs/server.key": "",
      "certs/server.pem": "",
      "app.py": "",
    });
    const walked = await collect(["."]);
    expect(pathsOf(walked)).toEqual(["app.py"]);
    expect(skipsOf(walked)).toEqual([
      { path: ".env", kind: "sensitive" },
      { path: "certs/server.key", kind: "sensitive" },
      { path: "certs/server.pem", kind: "sensitive" },
    ]);
    const named = await collect([".env"]);
    expect(skipsOf(named)).toEqual([{ path: ".env", kind: "sensitive" }]);
  });

  it("applies include and exclude globs from the config", async () => {
    await files({
      "src/app.ts": "",
      "src/app.test.ts": "",
      "scripts/tool.py": "",
      "src/.hidden/x.py": "",
    });
    const result = await collect(["."], {
      config: { include: ["src/**"], exclude: ["**/*.test.*"] },
    });
    expect(pathsOf(result)).toEqual(["src/.hidden/x.py", "src/app.ts"]);
    expect(skipsOf(result)).toEqual([
      { path: "scripts/tool.py", kind: "not-included" },
      { path: "src/app.test.ts", kind: "excluded" },
    ]);
  });

  it("skips directories an exclude glob covers entirely without walking them", async () => {
    await files({
      "dist/bundle.js": "",
      "node_modules/pkg/index.js": "",
      "a.js": "",
    });
    const result = await collect(["."]);
    expect(pathsOf(result)).toEqual(["a.js"]);
    expect(skipsOf(result)).toEqual([
      { path: "dist/", kind: "excluded" },
      { path: "node_modules/", kind: "excluded" },
    ]);
  });

  it("doesn't skip a directory whose name matches a file-level glob", async () => {
    await files({ "fixtures.test.d/data.py": "" });
    const result = await collect(["."], {
      config: { include: ["**/*"], exclude: ["**/*.test.*"] },
    });
    expect(pathsOf(result)).toEqual(["fixtures.test.d/data.py"]);
  });

  it("passes explicitly named unsupported files over with a reason", async () => {
    await files({ "notes.md": "" });
    const result = await collect(["notes.md"]);
    expect(skipsOf(result)).toEqual([
      { path: "notes.md", kind: "unsupported" },
    ]);
  });

  it("skips files over the size limit", async () => {
    await files({ "big.py": "x".repeat(20), "small.py": "x" });
    const result = await collect(["."], { maxFileBytes: 10 });
    expect(pathsOf(result)).toEqual(["small.py"]);
    expect(skipsOf(result)).toEqual([{ path: "big.py", kind: "too-large" }]);
  });

  it("reports missing paths and paths outside the root", async () => {
    const result = await collect(["nope.py", "../elsewhere.py"]);
    expect(skipsOf(result)).toEqual([
      { path: "nope.py", kind: "missing" },
      { path: "../elsewhere.py", kind: "outside-root" },
    ]);
  });

  it("never walks into .git and refuses paths inside it", async () => {
    await files({ ".git/hooks/pre-commit.py": "", "app.py": "" });
    expect(pathsOf(await collect(["."]))).toEqual(["app.py"]);
    expect(skipsOf(await collect([".git/hooks/pre-commit.py"]))).toEqual([
      { path: ".git/hooks/pre-commit.py", kind: "git-internal" },
    ]);
  });

  it("collects each file once when paths overlap", async () => {
    await files({ "src/a.py": "" });
    const result = await collect(["src", "src/a.py", "."]);
    expect(pathsOf(result)).toEqual(["src/a.py"]);
  });

  it("does not follow symbolic links", async (context) => {
    await files({ "real/a.py": "" });
    try {
      await symlink(join(root, "real"), join(root, "link"), "junction");
    } catch {
      context.skip(); // creating links can need extra rights on Windows
    }
    expect(pathsOf(await collect(["."]))).toEqual(["real/a.py"]);
    expect(skipsOf(await collect(["link"]))).toEqual([
      { path: "link", kind: "symlink" },
    ]);
  });

  it("does not follow a path through a linked folder", async (context) => {
    const outside = await mkdtemp(join(tmpdir(), "whycode-outside-"));
    try {
      await writeFile(join(outside, "secret.py"), "");
      try {
        await symlink(outside, join(root, "linked"), "junction");
      } catch {
        context.skip();
      }
      expect(skipsOf(await collect(["linked/secret.py"]))).toEqual([
        { path: "linked/secret.py", kind: "symlink" },
      ]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("accepts a path typed in a different case on Windows", async (context) => {
    if (process.platform !== "win32") context.skip();
    await files({ "Src/App.py": "" });
    expect(pathsOf(await collect(["src/app.py"]))).toHaveLength(1);
  });
});
