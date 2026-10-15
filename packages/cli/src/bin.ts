#!/usr/bin/env node
// The `whycode` executable: runs the CLI against the real process and exits
// with its code once all output has been flushed.
import { runCli } from "./cli.js";
import { processIo } from "./io.js";

process.exitCode = await runCli(process.argv.slice(2), processIo());
