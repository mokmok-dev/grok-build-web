import base from "../../stryker.base.mjs";

// Only the pure modules are mutated; the Effect socket client and the Node bridge are covered by
// integration tests against a real WebSocket server.
export default {
  ...base,
  mutate: ["src/jsonrpc-client.ts", "src/backoff.ts", "src/policy.ts"],
};
