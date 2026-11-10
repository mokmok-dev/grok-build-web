import { describe, expect, it } from "vitest";
import { createTask, type ChatMessage, type Task, type ToolCall } from "./task.ts";
import { taskToUiMessages } from "./ui-messages.ts";

const withMessages = (messages: readonly ChatMessage[]): Task => ({
  ...createTask({ id: "s1", cwd: "/tmp", now: 1 }),
  messages,
});

const toolMessage = (tool: Partial<ToolCall>): ChatMessage => ({
  id: "a1",
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
        arguments: "",
        ...tool,
      },
    },
  ],
});

describe("taskToUiMessages", () => {
  it("maps text, thinking and tool parts", () => {
    const task = withMessages([
      { id: "u", role: "user", createdAt: 1, parts: [{ type: "text", text: "hi" }] },
      {
        id: "a",
        role: "assistant",
        createdAt: 2,
        parts: [
          { type: "text", text: "hello" },
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
    ]);
    expect(taskToUiMessages(task)).toEqual([
      { id: "u", role: "user", parts: [{ type: "text", content: "hi" }] },
      {
        id: "a",
        role: "assistant",
        parts: [
          { type: "text", content: "hello" },
          { type: "thinking", content: "hmm" },
          {
            type: "tool-call",
            id: "t1",
            name: "shell",
            arguments: '{"command":"ls"}',
            state: "output-available",
            output: { ok: true },
          },
        ],
      },
    ]);
  });

  it("serializes tool input when there are no streamed arguments", () => {
    const task = withMessages([toolMessage({ input: { command: "ls" } })]);
    expect(taskToUiMessages(task)[0]?.parts[0]).toMatchObject({
      arguments: '{"command":"ls"}',
      state: "input-available",
    });
  });

  it("defaults arguments and output for a bare tool", () => {
    const task = withMessages([toolMessage({})]);
    expect(taskToUiMessages(task)[0]?.parts[0]).toEqual({
      type: "tool-call",
      id: "t1",
      name: "shell",
      arguments: "{}",
      state: "input-available",
      output: undefined,
    });
  });

  it("returns no messages for an empty task", () => {
    expect(taskToUiMessages(withMessages([]))).toEqual([]);
  });
});
