import { describe, expect, it } from "vitest";
import {
  basename,
  connectionOf,
  relativeTime,
  STATUS_LABELS,
  taskTitle,
  toInitialMessages,
  usageLine,
  type TaskDetail,
} from "./api.ts";

describe("basename", () => {
  it("returns the last path segment", () => {
    expect(basename("/tmp/work")).toBe("work");
    expect(basename("/tmp/work/")).toBe("work");
    expect(basename("work")).toBe("work");
    expect(basename("/")).toBe("/");
  });
});

describe("relativeTime", () => {
  it("describes recent and older timestamps", () => {
    expect(relativeTime(1_000, 1_000)).toBe("0s ago");
    expect(relativeTime(1_000, 31_000)).toBe("30s ago");
    expect(relativeTime(0, 120_000)).toBe("2m ago");
    expect(relativeTime(0, 2 * 3_600_000)).toBe("2h ago");
    expect(relativeTime(0, 2 * 86_400_000)).toBe("2d ago");
    expect(relativeTime(0, 60_000)).toBe("1m ago");
    expect(relativeTime(0, 3_600_000)).toBe("1h ago");
    expect(relativeTime(0, 86_400_000)).toBe("1d ago");
    expect(relativeTime(0, 59_000)).toBe("59s ago");
    expect(relativeTime(10_000, 1_000)).toBe("0s ago");
  });
});

describe("labels", () => {
  it("names every status", () => {
    expect(STATUS_LABELS).toEqual({
      starting: "Starting",
      idle: "Idle",
      running: "Running",
      awaiting_permission: "Awaiting permission",
      error: "Error",
      closed: "Closed",
    });
  });

  it("derives the connection state from health", () => {
    expect(connectionOf(null)).toBe("disconnected");
    expect(connectionOf({ ok: true, acp: { connected: true, url: "ws://x" } })).toBe("connected");
    expect(connectionOf({ ok: true, acp: { connected: false, url: "ws://x" } })).toBe(
      "disconnected",
    );
    expect(
      connectionOf({ ok: true, acp: { connected: false, url: "ws://x", lastError: "lost" } }),
    ).toBe("reconnecting");
  });

  it("falls back for an untitled task", () => {
    expect(taskTitle({ title: "" })).toBe("Untitled task");
    expect(taskTitle({ title: "T" })).toBe("T");
  });

  it("formats usage", () => {
    expect(usageLine({})).toBe("");
    expect(usageLine({ inputTokens: 1 })).toBe("1 in");
    expect(usageLine({ inputTokens: 1, outputTokens: 2, totalTokens: 3 })).toBe(
      "1 in · 2 out · 3 total",
    );
  });
});

describe("toInitialMessages", () => {
  const detail = (messages: TaskDetail["messages"]): TaskDetail => ({
    id: "s1",
    title: "",
    cwd: "/tmp",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    messageCount: messages.length,
    usage: {},
    yolo: false,
    messages,
    plan: [],
    availableCommands: [],
    configOptions: [],
    queue: [],
  });

  it("maps text, thinking and tool parts", () => {
    const messages = toInitialMessages(
      detail([
        { id: "u", role: "user", createdAt: 1, parts: [{ type: "text", text: "hi" }] },
        {
          id: "a",
          role: "assistant",
          createdAt: 2,
          parts: [
            { type: "thinking", text: "hmm" },
            {
              type: "tool",
              tool: {
                toolCallId: "t1",
                name: "shell",
                title: "Run",
                status: "completed",
                input: { command: "ls" },
                output: { ok: true },
                arguments: '{"command":"ls"}',
              },
            },
          ],
        },
      ]),
    );
    expect(messages).toEqual([
      { id: "u", role: "user", parts: [{ type: "text", content: "hi" }] },
      {
        id: "a",
        role: "assistant",
        parts: [
          { type: "thinking", content: "hmm" },
          {
            type: "tool-call",
            id: "t1",
            name: "shell",
            arguments: '{"command":"ls"}',
            state: "complete",
            output: { ok: true },
          },
        ],
      },
    ]);
  });

  it("serializes input when arguments are empty", () => {
    const messages = toInitialMessages(
      detail([
        {
          id: "a",
          role: "assistant",
          createdAt: 1,
          parts: [
            {
              type: "tool",
              tool: {
                toolCallId: "t1",
                name: "shell",
                title: "Run",
                status: "pending",
                input: { command: "ls" },
                arguments: "",
              },
            },
          ],
        },
      ]),
    );
    expect(messages[0]?.parts[0]).toMatchObject({
      arguments: '{"command":"ls"}',
      state: "input-complete",
    });
  });
});
