export default {
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  vitest: { configFile: "vitest.config.ts" },
  mutate: ["src/jsonrpc-client.ts", "src/backoff.ts", "src/policy.ts"],
  thresholds: { high: 100, low: 100, break: 100 },
  coverageAnalysis: "perTest",
  concurrency: 2,
  reporters: ["clear-text", "progress"],
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
};
