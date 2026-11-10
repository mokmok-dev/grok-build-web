import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "task-model", environment: "node", include: ["src/**/*.test.ts"] },
});
