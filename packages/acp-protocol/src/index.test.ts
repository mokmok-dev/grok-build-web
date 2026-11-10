import { expect, test } from "vitest";
import { PACKAGE_NAME } from "./index.ts";

test("exports its package name", () => {
  expect(PACKAGE_NAME).toBe("@grok-build-web/acp-protocol");
});
