// Injected into the CommonJS bundle by build.mjs. Bundled ES modules
// (Prettier, web-tree-sitter) use import.meta.url to find files next to
// themselves, but a CommonJS file has no import.meta, so they get the URL of
// the bundle itself: web-tree-sitter then finds web-tree-sitter.wasm in dist/.
/* global __filename -- set by the CommonJS module wrapper the bundle runs in */
import { pathToFileURL } from "node:url";

export const importMetaUrl = pathToFileURL(__filename).href;
