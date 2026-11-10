import { describe, expect, it } from "vitest";
import {
  emptyResponse,
  parseClientRequest,
  permissionCancelled,
  permissionSelected,
  readFileResponse,
} from "./client-methods.ts";

describe("parseClientRequest", () => {
  it("rejects non-objects and unknown methods", () => {
    expect(parseClientRequest("fs/read_text_file", null)).toBeUndefined();
    expect(parseClientRequest("fs/unknown", {})).toBeUndefined();
  });

  it("parses file reads", () => {
    expect(
      parseClientRequest("fs/read_text_file", {
        sessionId: "s",
        path: "/tmp/a",
        line: 2,
        limit: 3,
      }),
    ).toEqual({ kind: "fs_read", sessionId: "s", path: "/tmp/a", line: 2, limit: 3 });
    expect(parseClientRequest("fs/read_text_file", { sessionId: "s", path: "/tmp/a" })).toEqual({
      kind: "fs_read",
      sessionId: "s",
      path: "/tmp/a",
      line: undefined,
      limit: undefined,
    });
    expect(parseClientRequest("fs/read_text_file", { path: "/tmp/a" })).toBeUndefined();
    expect(parseClientRequest("fs/read_text_file", { sessionId: "s" })).toBeUndefined();
  });

  it("parses file writes", () => {
    expect(
      parseClientRequest("fs/write_text_file", { sessionId: "s", path: "/tmp/a", content: "hi" }),
    ).toEqual({ kind: "fs_write", sessionId: "s", path: "/tmp/a", content: "hi" });
    expect(
      parseClientRequest("fs/write_text_file", { sessionId: "s", path: "/tmp/a" }),
    ).toBeUndefined();
    expect(
      parseClientRequest("fs/write_text_file", { sessionId: "s", content: "hi" }),
    ).toBeUndefined();
    expect(parseClientRequest("fs/write_text_file", { path: "/a", content: "hi" })).toBeUndefined();
  });

  it("parses terminal creation", () => {
    expect(
      parseClientRequest("terminal/create", {
        sessionId: "s",
        command: "echo",
        args: ["hi", 3],
        env: [{ name: "A", value: "1" }, { name: "B" }, { value: "2" }, 5],
        cwd: "/tmp",
        outputByteLimit: 100,
      }),
    ).toEqual({
      kind: "terminal_create",
      sessionId: "s",
      command: "echo",
      args: ["hi"],
      env: [
        { name: "A", value: "1" },
        { name: "B", value: "" },
      ],
      cwd: "/tmp",
      outputByteLimit: 100,
    });
    expect(parseClientRequest("terminal/create", { sessionId: "s", command: "echo" })).toEqual({
      kind: "terminal_create",
      sessionId: "s",
      command: "echo",
      args: [],
      env: [],
      cwd: undefined,
      outputByteLimit: undefined,
    });
    expect(parseClientRequest("terminal/create", { command: "echo" })).toBeUndefined();
    expect(parseClientRequest("terminal/create", { sessionId: "s" })).toBeUndefined();
  });

  it("parses terminal operations", () => {
    expect(parseClientRequest("terminal/output", { sessionId: "s", terminalId: "t" })).toEqual({
      kind: "terminal_output",
      sessionId: "s",
      terminalId: "t",
    });
    expect(
      parseClientRequest("terminal/wait_for_exit", { sessionId: "s", terminalId: "t" }),
    ).toEqual({
      kind: "terminal_wait_for_exit",
      sessionId: "s",
      terminalId: "t",
    });
    expect(parseClientRequest("terminal/kill", { sessionId: "s", terminalId: "t" })).toEqual({
      kind: "terminal_kill",
      sessionId: "s",
      terminalId: "t",
    });
    expect(parseClientRequest("terminal/release", { sessionId: "s", terminalId: "t" })).toEqual({
      kind: "terminal_release",
      sessionId: "s",
      terminalId: "t",
    });
    expect(parseClientRequest("terminal/kill", { sessionId: "s" })).toBeUndefined();
    expect(parseClientRequest("terminal/kill", { terminalId: "t" })).toBeUndefined();
  });

  it("parses permission requests", () => {
    expect(
      parseClientRequest("session/request_permission", {
        sessionId: "s",
        toolCall: { toolCallId: "t", title: "Run ls" },
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "bare" },
          { name: "no id" },
          9,
        ],
      }),
    ).toEqual({
      kind: "request_permission",
      sessionId: "s",
      toolCallId: "t",
      title: "Run ls",
      options: [
        { optionId: "allow_once", name: "Allow", kind: "allow_once" },
        { optionId: "bare", name: "", kind: "" },
      ],
    });
    expect(
      parseClientRequest("session/request_permission", {
        sessionId: "s",
        toolCall: { toolCallId: "t" },
      }),
    ).toEqual({
      kind: "request_permission",
      sessionId: "s",
      toolCallId: "t",
      title: "",
      options: [],
    });
    expect(parseClientRequest("session/request_permission", { sessionId: "s" })).toBeUndefined();
    expect(
      parseClientRequest("session/request_permission", { sessionId: "s", toolCall: {} }),
    ).toBeUndefined();
    expect(
      parseClientRequest("session/request_permission", { toolCall: { toolCallId: "t" } }),
    ).toBeUndefined();
  });
});

describe("response builders", () => {
  it("builds wire responses", () => {
    expect(readFileResponse("hi")).toEqual({ content: "hi" });
    expect(emptyResponse()).toEqual({});
    expect(permissionSelected("allow_once")).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    expect(permissionCancelled()).toEqual({ outcome: { outcome: "cancelled" } });
  });
});
