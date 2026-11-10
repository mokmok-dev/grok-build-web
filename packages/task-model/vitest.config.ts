import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@grok-build-web/acp-protocol": new URL("../acp-protocol/src/index.ts", import.meta.url)
        .pathname,
    },
  },
  test: { name: "task-model", environment: "node", include: ["src/**/*.test.ts"] },
});
