// Mutation scope is packages/*, the acceptance criterion for the gate. The apps/* HTTP and UI layers
// are covered by integration and Playwright tests instead; see README "Checks".
export default {
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  vitest: { configFile: "vitest.config.ts" },
  thresholds: { high: 100, low: 100, break: 100 },
  coverageAnalysis: "perTest",
  concurrency: 2,
  reporters: ["clear-text", "progress"],
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
};
