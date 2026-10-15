// Tests for working out which files a command applies to.
import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { commandTargets } from "./targets.js";
import { fake } from "./testing/fake-vscode.js";

const a = vscode.Uri.file("/project/a.py");
const b = vscode.Uri.file("/project/src");

beforeEach(() => fake.reset());

describe("commandTargets", () => {
  it("uses the whole Explorer selection", () => {
    expect(commandTargets(a, [a, b])).toEqual([a, b]);
  });

  it("uses the clicked file from an editor menu", () => {
    expect(commandTargets(a, { groupId: 0 })).toEqual([a]);
  });

  it("falls back to the active editor's file from the Command Palette", () => {
    fake.activeFile = "/project/open.py";
    expect(commandTargets(undefined, undefined)).toEqual([
      vscode.Uri.file("/project/open.py"),
    ]);
  });

  it("returns nothing when there is no file to act on", () => {
    expect(commandTargets(undefined, undefined)).toEqual([]);
  });
});
