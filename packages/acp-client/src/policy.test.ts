import type { PermissionOption } from "@grok-build-web/acp-protocol";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowedRoots,
  autoSelectOption,
  isWithin,
  mayCreateTerminal,
  resolveAllowedPath,
  resolveCandidate,
  truncateOutput,
} from "./policy.ts";

const option = (optionId: string, kind: string): PermissionOption => ({
  optionId,
  name: optionId,
  kind,
});

describe("isWithin", () => {
  it("accepts the root and its children only", () => {
    expect(isWithin("/a/b", "/a/b")).toBe(true);
    expect(isWithin("/a/b/c.ts", "/a/b")).toBe(true);
    expect(isWithin("/a/bc", "/a/b")).toBe(false);
    expect(isWithin("/a", "/a/b")).toBe(false);
  });

  it("tolerates a trailing separator on the root", () => {
    expect(isWithin("/a/b/c", "/a/b/")).toBe(true);
  });

  it("treats the filesystem root as containing everything", () => {
    expect(isWithin("/a/b", "/")).toBe(true);
  });
});

describe("resolveCandidate", () => {
  it("resolves relative paths against the cwd", () => {
    expect(resolveCandidate("notes.txt", "/work")).toBe("/work/notes.txt");
    expect(resolveCandidate("../x", "/work/sub")).toBe("/work/x");
  });

  it("keeps absolute paths", () => {
    expect(resolveCandidate("/tmp/x", "/work")).toBe("/tmp/x");
  });
});

describe("allowedRoots", () => {
  it("resolves the cwd and every extra root against the process cwd", () => {
    expect(allowedRoots("/work", ["/tmp", "rel"])).toEqual(["/work", "/tmp", resolve("rel")]);
  });
});

describe("resolveAllowedPath", () => {
  it("accepts paths under the cwd", () => {
    expect(resolveAllowedPath("src/a.ts", "/work", [])).toBe("/work/src/a.ts");
    expect(resolveAllowedPath("/work", "/work", [])).toBe("/work");
  });

  it("accepts paths under an extra root", () => {
    expect(resolveAllowedPath("/tmp/a", "/work", ["/tmp"])).toBe("/tmp/a");
  });

  it("rejects escapes and unrelated paths", () => {
    expect(resolveAllowedPath("../../etc/passwd", "/work/sub", [])).toBeUndefined();
    expect(resolveAllowedPath("/etc/passwd", "/work", [])).toBeUndefined();
  });
});

describe("autoSelectOption", () => {
  const once = option("once", "allow_once");
  const always = option("always", "allow_always");

  it("refuses to choose outside yolo mode", () => {
    expect(autoSelectOption([once], false)).toBeUndefined();
  });

  it("prefers allow_once over allow_always", () => {
    expect(autoSelectOption([always, once], true)).toBe("once");
  });

  it("falls back to allow_always", () => {
    expect(autoSelectOption([always], true)).toBe("always");
  });

  it("returns undefined when only rejecting options exist", () => {
    expect(autoSelectOption([option("no", "reject_once")], true)).toBeUndefined();
    expect(autoSelectOption([], true)).toBeUndefined();
  });
});

describe("mayCreateTerminal", () => {
  it("blocks read-only mode", () => {
    expect(mayCreateTerminal(true, 0, 8)).toBe(false);
  });

  it("enforces the terminal cap", () => {
    expect(mayCreateTerminal(false, 7, 8)).toBe(true);
    expect(mayCreateTerminal(false, 8, 8)).toBe(false);
    expect(mayCreateTerminal(false, 0, 0)).toBe(false);
  });
});

describe("truncateOutput", () => {
  it("keeps output within the limit", () => {
    expect(truncateOutput("abc", 10)).toEqual({ output: "abc", truncated: false });
    expect(truncateOutput("abc", 3)).toEqual({ output: "abc", truncated: false });
  });

  it("keeps the tail beyond the limit", () => {
    expect(truncateOutput("abcdef", 3)).toEqual({ output: "def", truncated: true });
    expect(truncateOutput("abc", 0)).toEqual({ output: "", truncated: true });
    expect(truncateOutput("abc", -1)).toEqual({ output: "", truncated: true });
  });
});
