// Tests for detecting whether a project has adopted a formatter, from
// config files and dependencies in the file's folder or any folder above.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  csharpierAdopted,
  googleJavaFormatAdopted,
  prettierAdopted,
  prettierConfigRunsCode,
  prettierIgnoreFor,
  ruffAdopted,
} from "./formatter-adoption.js";

describe("formatter adoption", () => {
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), "whycode-adopt-"));
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  async function files(entries: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(entries)) {
      await mkdir(dirname(join(project, path)), { recursive: true });
      await writeFile(join(project, path), content);
    }
  }

  const source = (path: string) => join(project, path);

  it("finds nothing in a project without formatter settings", async () => {
    await files({ "package.json": '{"name":"x"}', "src/a.ts": "" });
    expect(await prettierAdopted(source("src/a.ts"))).toBe(false);
    expect(await ruffAdopted(source("src/a.py"))).toBe(false);
    expect(await csharpierAdopted(source("src/A.cs"))).toBe(false);
    expect(await googleJavaFormatAdopted(source("src/A.java"))).toBe(false);
  });

  it.each([
    [".prettierrc", "{}"],
    ["prettier.config.mjs", "export default {};"],
    ["package.json", '{"prettier":{"semi":false}}'],
    ["package.json", '{"devDependencies":{"prettier":"^3.0.0"}}'],
  ])("sees Prettier from %s", async (name, content) => {
    await files({ [name]: content, "src/deep/a.ts": "" });
    expect(await prettierAdopted(source("src/deep/a.ts"))).toBe(true);
  });

  it.each([
    ["ruff.toml", "line-length = 100"],
    [".ruff.toml", ""],
    [
      "pyproject.toml",
      "[project]\nname='x'\n\n[tool.ruff]\nline-length = 88\n",
    ],
  ])("sees Ruff from %s", async (name, content) => {
    await files({ [name]: content, "pkg/a.py": "" });
    expect(await ruffAdopted(source("pkg/a.py"))).toBe(true);
  });

  it("does not substitute Ruff for a Black-only project", async () => {
    await files({
      "pyproject.toml": "[tool.black]\nskip-string-normalization = true\n",
    });
    expect(await ruffAdopted(source("a.py"))).toBe(false);
  });

  it("does not mistake unrelated manifest keys for Prettier adoption", async () => {
    await files({ "package.json": '{"customMetadata":{"prettier":false}}' });
    expect(await prettierAdopted(source("a.js"))).toBe(false);
  });

  it("reports malformed manifests instead of treating raw text as adoption", async () => {
    await files({ "package.json": '{"devDependencies":{"prettier":' });
    await expect(prettierAdopted(source("a.js"))).rejects.toThrow(
      /package.json/,
    );
  });

  it("stops at a nested repository but allows inheritance within a workspace", async () => {
    await files({
      ".prettierrc": "{}",
      "ruff.toml": "",
      "nested/.git": "gitdir: somewhere",
    });
    expect(await prettierAdopted(source("packages/a/a.js"))).toBe(true);
    expect(await prettierAdopted(source("nested/src/a.js"))).toBe(false);
    expect(await ruffAdopted(source("nested/src/a.py"))).toBe(false);
  });

  it("finds the .prettierignore that excludes a file, read relative to its folder", async () => {
    await files({
      ".git": "gitdir: somewhere",
      ".prettierignore": "legacy.ts\n",
      "pkg/.prettierignore": "generated/\n",
    });
    expect(await prettierIgnoreFor(source("src/legacy.ts"))).toBe(
      join(project, ".prettierignore"),
    );
    expect(await prettierIgnoreFor(source("pkg/generated/a.ts"))).toBe(
      join(project, "pkg", ".prettierignore"),
    );
    expect(await prettierIgnoreFor(source("generated/a.ts"))).toBeUndefined();
    expect(await prettierIgnoreFor(source("src/main.ts"))).toBeUndefined();
  });

  it("ignores a .prettierignore outside the repository", async () => {
    await files({
      ".prettierignore": "*.ts\n",
      "inner/.git": "gitdir: somewhere",
    });
    expect(await prettierIgnoreFor(source("inner/a.ts"))).toBeUndefined();
  });

  it.each([
    ["prettier.config.mjs", "export default {};", "is JavaScript"],
    [".prettierrc.cjs", "module.exports = {};", "is JavaScript"],
    [
      ".prettierrc",
      '{"plugins":["prettier-plugin-x"]}',
      "names Prettier plugins",
    ],
    [
      ".prettierrc.yaml",
      "overrides:\n  - files: '*.x'\n    options:\n      plugins: [x]\n",
      "names Prettier plugins",
    ],
    [
      ".prettierrc",
      '"@company/prettier-config"',
      "shared Prettier config package",
    ],
    [
      ".prettierrc.yaml",
      "# shared\n@company/prettier-config\n",
      "shared Prettier config package",
    ],
    [
      "package.json",
      '{"prettier":"@company/prettier-config"}',
      "shared Prettier config package",
    ],
  ])(
    "sees that Prettier would run code from %s",
    async (name, content, why) => {
      await files({ [name]: content });
      expect(await prettierConfigRunsCode(source("src/a.ts"))).toContain(why);
    },
  );

  it.each([
    [".prettierrc", '{"semi":false}'],
    [".prettierrc.json", "{}"],
    [".prettierrc.json5", "{ semi: false }"],
    [".prettierrc.toml", "semi = false\n"],
    ["package.json", '{"prettier":{"semi":false}}'],
    ["package.json", '{"devDependencies":{"prettier":"^3.0.0"}}'],
  ])("finds nothing to run in a declarative %s", async (name, content) => {
    await files({ [name]: content });
    expect(await prettierConfigRunsCode(source("a.ts"))).toBeUndefined();
  });

  it("checks .prettierignore without running a JavaScript config", async () => {
    await files({
      ".git": "gitdir: somewhere",
      ".prettierignore": "legacy.ts\n",
      "prettier.config.mjs":
        'import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./RAN.txt", import.meta.url), "ran");\nexport default {};\n',
    });
    expect(await prettierIgnoreFor(source("legacy.ts"))).toBeDefined();
    expect(await prettierIgnoreFor(source("main.ts"))).toBeUndefined();
    expect(existsSync(source("RAN.txt"))).toBe(false);
  });

  it("doesn't count a pyproject.toml without formatter settings", async () => {
    await files({ "pyproject.toml": "[project]\nname = 'x'\n" });
    expect(await ruffAdopted(source("a.py"))).toBe(false);
  });

  it.each([
    [".csharpierrc.json", "{}"],
    [
      ".config/dotnet-tools.json",
      '{"tools":{"csharpier":{"version":"1.0.0"}}}',
    ],
    ["App.csproj", '<PackageReference Include="CSharpier.MSBuild" />'],
  ])("sees CSharpier from %s", async (name, content) => {
    await files({ [name]: content });
    expect(await csharpierAdopted(source("src/A.cs"))).toBe(true);
  });

  it.each([
    ["build.gradle.kts", "spotless { java { googleJavaFormat() } }"],
    [
      "pom.xml",
      "<artifactId>fmt-maven-plugin</artifactId><style>google-java-format</style>",
    ],
  ])("sees google-java-format from %s", async (name, content) => {
    await files({ [name]: content });
    expect(await googleJavaFormatAdopted(source("src/main/A.java"))).toBe(true);
  });
});
