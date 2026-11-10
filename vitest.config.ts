import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/acp-protocol",
      "packages/task-model",
      "packages/acp-client",
      "apps/server",
      "apps/web",
    ],
  },
});
