#!/usr/bin/env node
// The `whycode` executable: runs the CLI against the real process and exits
// with its code once all output has been flushed.
import { fileURLToPath } from "node:url";
import { useGrammarDirectory } from "@whycode/core";
import { runCli } from "./cli.js";
import { processIo } from "./io.js";

// The build copies the tree-sitter grammars next to this file (scripts/build.mjs).
useGrammarDirectory(fileURLToPath(new URL("grammars", import.meta.url)));
process.exitCode = await runCli(process.argv.slice(2), processIo());
