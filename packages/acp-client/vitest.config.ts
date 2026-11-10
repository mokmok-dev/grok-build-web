import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Stryker runs tests inside .stryker-tmp/sandbox-*; walking up finds the real workspace root there too.
const findWorkspaceRoot = (start: string): string => {
  let current = start;
  while (!existsSync(join(current, "pnpm-workspace.yaml"))) {
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
  return current;
};

const root = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));

export default defineConfig({
  resolve: {
    alias: {
      "@grok-build-web/acp-protocol": join(root, "packages/acp-protocol/src/index.ts"),
    },
  },
  test: { name: "acp-client", environment: "node", include: ["src/**/*.test.ts"] },
});
