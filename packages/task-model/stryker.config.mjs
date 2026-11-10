import base from "../../stryker.base.mjs";

export default {
  ...base,
  mutate: ["src/**/*.ts", "!src/**/*.test.ts", "!src/index.ts"],
};
