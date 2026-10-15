// The language adapters WhyCode ships with. Front-ends pass `defaultAdapters`
// to processFile; languages not listed here fall back to comments-only mode.
import type { LanguageAdapter } from "./adapter.js";
import { goAdapter } from "./go.js";
import { pythonAdapter } from "./python.js";
import { rustAdapter } from "./rust.js";
import {
  javascriptAdapter,
  tsxAdapter,
  typescriptAdapter,
} from "./typescript.js";

export const defaultAdapters: readonly LanguageAdapter[] = [
  goAdapter,
  pythonAdapter,
  rustAdapter,
  typescriptAdapter,
  tsxAdapter,
  javascriptAdapter,
];
