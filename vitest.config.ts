// Root Vitest config: every folder under packages/ is its own test project.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*"],
  },
});
