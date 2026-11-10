import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const listOf = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev only: `pnpm dev:tailnet` sets both variables to the Tailscale address.
    allowedHosts: listOf(process.env["GROK_WEB_ALLOWED_HOSTS"]),
    host: process.env["GROK_WEB_DEV_HOST"] ?? "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.GROK_WEB_API_URL ?? "http://127.0.0.1:3000",
        changeOrigin: false,
      },
    },
  },
  test: {
    name: "web",
    environment: "jsdom",
    include: ["src/**/*.test.tsx", "src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
