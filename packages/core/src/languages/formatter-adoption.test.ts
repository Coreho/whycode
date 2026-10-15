// Tests for detecting whether a project has adopted a formatter, from
// config files and dependencies in the file's folder or any folder above.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  csharpierAdopted,
  googleJavaFormatAdopted,
  prettierAdopted,
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
    ["pyproject.toml", "[tool.black]\nline-length = 88\n"],
  ])("sees Ruff or Black from %s", async (name, content) => {
    await files({ [name]: content, "pkg/a.py": "" });
    expect(await ruffAdopted(source("pkg/a.py"))).toBe(true);
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
