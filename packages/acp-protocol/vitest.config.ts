import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "acp-protocol", environment: "node", include: ["src/**/*.test.ts"] },
});
