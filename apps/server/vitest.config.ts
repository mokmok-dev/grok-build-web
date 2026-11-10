import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@grok-build-web/acp-client": new URL(
        "../../packages/acp-client/src/index.ts",
        import.meta.url,
      ).pathname,
      "@grok-build-web/acp-protocol": new URL(
        "../../packages/acp-protocol/src/index.ts",
        import.meta.url,
      ).pathname,
      "@grok-build-web/task-model": new URL(
        "../../packages/task-model/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: { name: "server", environment: "node", include: ["test/**/*.test.ts", "src/**/*.test.ts"] },
});
