import type { ServerNotification, SessionUpdate } from "@grok-build-web/acp-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyNotification,
  applySessionChange,
  createTask,
  failPrompt,
  markClosed,
  markError,
  markReady,
  mergeUsage,
  resolvePermission,
  setPendingPermission,
  startPrompt,
  finishPrompt,
  toDetail,
  toSummary,
  type ChatMessage,
  type Task,
  type ToolCall,
} from "./task.ts";

const task = (patch: Partial<Task> = {}): Task => ({
  ...createTask({ id: "s1", cwd: "/tmp", title: "T", model: "m", now: 1 }),
  status: "idle",
  ...patch,
});

const update = (value: SessionUpdate, current: Task = task()): Task =>
  applyNotification(current, { kind: "session_update", sessionId: "s1", update: value }, 10);

const notification = (value: ServerNotification, current: Task = task()): Task =>
  applyNotification(current, value, 10);

const assistant = (parts: ChatMessage["parts"], id = "a1"): ChatMessage => ({
  id,
  role: "assistant",
  createdAt: 1,
  parts,
});

const textTool = (tool: Partial<ToolCall>): ChatMessage => ({
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

const permission = { requestId: "r", toolCallId: "t", title: "Run", options: [] };

const lastMessage = (current: Task): ChatMessage => {
  const message = current.messages[current.messages.length - 1];
  if (message === undefined) throw new Error("no messages");
  return message;
};

describe("createTask", () => {
  it("starts in the starting state", () => {
    expect(createTask({ id: "s", cwd: "/tmp", now: 5 })).toEqual({
      id: "s",
      cwd: "/tmp",
      title: "",
      model: undefined,
      status: "starting",
      createdAt: 5,
      updatedAt: 5,
      messages: [],
      plan: [],
      usage: {},
      lastError: undefined,
      pendingPermission: undefined,
      availableCommands: [],
      configOptions: [],
      queue: [],
      runningPromptId: undefined,
      yolo: false,
    });
  });

  it("keeps an explicit title, model and yolo flag", () => {
    const created = createTask({
      id: "s",
      cwd: "/tmp",
      title: "T",
      model: "m",
      yolo: true,
      now: 5,
    });
    expect(created.title).toBe("T");
    expect(created.model).toBe("m");
    expect(created.yolo).toBe(true);
  });
});

describe("lifecycle", () => {
  it("marks a task ready", () => {
    const ready = markReady(task({ status: "starting" }), 7);
    expect(ready.status).toBe("idle");
    expect(ready.updatedAt).toBe(7);
  });

  it("marks a task closed", () => {
    expect(markClosed(task(), 7)).toMatchObject({ status: "closed", updatedAt: 7 });
  });

  it("marks a task errored and clears the running prompt", () => {
    expect(markError(task({ runningPromptId: "p1" }), "boom", 7)).toMatchObject({
      status: "error",
      lastError: "boom",
      runningPromptId: undefined,
      updatedAt: 7,
    });
  });

  it("appends a user message and records the running prompt claim", () => {
    const next = startPrompt(task(), "p1", "hello", 7);
    expect(next.status).toBe("running");
    expect(next.runningPromptId).toBe("p1");
    expect(next.messages).toEqual([
      { id: "user-0", role: "user", createdAt: 7, parts: [{ type: "text", text: "hello" }] },
    ]);
    expect(next.updatedAt).toBe(7);
  });

  it("finishes a prompt into idle or awaiting permission", () => {
    expect(finishPrompt(task({ status: "running", runningPromptId: "c1" }), "c1", 8)).toMatchObject(
      {
        status: "idle",
        runningPromptId: undefined,
        updatedAt: 8,
      },
    );
    expect(
      finishPrompt(
        task({ status: "running", runningPromptId: "c1", pendingPermission: permission }),
        "c1",
        8,
      ).status,
    ).toBe("awaiting_permission");
  });

  it("keeps a claim that belongs to another turn", () => {
    const current = task({ status: "running", runningPromptId: "c1" });
    expect(finishPrompt(current, "other", 8)).toBe(current);
  });

  it("fails a task only for the turn that owns the claim", () => {
    expect(
      failPrompt(task({ status: "running", runningPromptId: "c1" }), "c1", "boom", 8),
    ).toMatchObject({
      status: "error",
      lastError: "boom",
      runningPromptId: undefined,
      updatedAt: 8,
    });
    const current = task({ status: "running", runningPromptId: "c2" });
    expect(failPrompt(current, "c1", "late", 8)).toBe(current);
  });

  it("sets and clears a pending permission", () => {
    const pending = setPendingPermission(task(), permission, 7);
    expect(pending.status).toBe("awaiting_permission");
    expect(pending.pendingPermission).toEqual(permission);
    expect(resolvePermission(pending, 8)).toMatchObject({
      status: "idle",
      pendingPermission: undefined,
      updatedAt: 8,
    });
    expect(resolvePermission({ ...pending, runningPromptId: "p" }, 8).status).toBe("running");
  });
});

describe("mergeUsage", () => {
  it("returns the base when the patch is absent", () => {
    const base = { totalTokens: 1 };
    expect(mergeUsage(base, undefined)).toBe(base);
  });

  it("fills only the counters the patch provides", () => {
    expect(
      mergeUsage({ inputTokens: 1, totalTokens: 2 }, { totalTokens: 9, outputTokens: 3 }),
    ).toEqual({
      inputTokens: 1,
      outputTokens: 3,
      totalTokens: 9,
      reasoningTokens: undefined,
    });
  });

  it("keeps base counters the patch omits", () => {
    expect(mergeUsage({ reasoningTokens: 5, outputTokens: 6 }, {})).toEqual({
      inputTokens: undefined,
      outputTokens: 6,
      totalTokens: undefined,
      reasoningTokens: 5,
    });
  });
});

describe("text chunks", () => {
  it("creates an assistant message and appends to the same part", () => {
    const first = update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "a" },
    });
    expect(first.messages).toEqual([
      { id: "assistant-0", role: "assistant", createdAt: 10, parts: [{ type: "text", text: "a" }] },
    ]);
    const second = update(
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" } },
      first,
    );
    expect(second.messages).toHaveLength(1);
    expect(lastMessage(second).parts).toEqual([{ type: "text", text: "ab" }]);
    expect(second.updatedAt).toBe(10);
  });

  it("groups chunks by message id", () => {
    const first = update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "a" },
      messageId: "m1",
    });
    expect(first.messages[0]?.id).toBe("m1");
    const second = update(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "b" },
        messageId: "m1",
      },
      first,
    );
    expect(second.messages).toHaveLength(1);
    expect(lastMessage(second).parts).toEqual([{ type: "text", text: "ab" }]);
    const third = update(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "c" },
        messageId: "m2",
      },
      second,
    );
    expect(third.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(lastMessage(third).parts).toEqual([{ type: "text", text: "c" }]);
  });

  it("updates only the addressed message", () => {
    const existing = task({
      messages: [
        assistant([{ type: "text", text: "a" }], "m1"),
        assistant([{ type: "text", text: "b" }], "m2"),
      ],
    });
    const next = update(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "!" },
        messageId: "m1",
      },
      existing,
    );
    expect(next.messages).toEqual([
      assistant([{ type: "text", text: "a!" }], "m1"),
      assistant([{ type: "text", text: "b" }], "m2"),
    ]);
  });

  it("opens a new assistant message after a user message", () => {
    const next = update(
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } },
      startPrompt(task(), "p1", "hi", 5),
    );
    expect(next.messages.map((message) => message.id)).toEqual(["user-0", "assistant-1"]);
  });

  it("separates thinking from text parts", () => {
    const withText = update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "a" },
    });
    const withThinking = update(
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "t" } },
      withText,
    );
    expect(lastMessage(withThinking).parts).toEqual([
      { type: "text", text: "a" },
      { type: "thinking", text: "t" },
    ]);
    const moreThinking = update(
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "u" } },
      withThinking,
    );
    expect(lastMessage(moreThinking).parts).toEqual([
      { type: "text", text: "a" },
      { type: "thinking", text: "tu" },
    ]);
    const moreText = update(
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" } },
      moreThinking,
    );
    expect(lastMessage(moreText).parts).toEqual([
      { type: "text", text: "a" },
      { type: "thinking", text: "tu" },
      { type: "text", text: "b" },
    ]);
  });
});

describe("tool calls", () => {
  it("creates a tool part and normalizes the status", () => {
    const next = update({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Run",
      name: "shell",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "ls" },
    });
    expect(lastMessage(next).parts).toEqual([
      {
        type: "tool",
        tool: {
          toolCallId: "t1",
          name: "shell",
          title: "Run",
          kind: "execute",
          status: "in_progress",
          input: { command: "ls" },
          output: undefined,
          arguments: "",
        },
      },
    ]);
  });

  it("maps every tool status and a missing one", () => {
    const statuses = ["pending", "in_progress", "completed", "failed", "other", undefined];
    expect(
      statuses.map((status) => {
        const next = update({
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "Run",
          status,
        });
        const part = lastMessage(next).parts[0];
        return part?.type === "tool" ? part.tool.status : "missing";
      }),
    ).toEqual(["pending", "in_progress", "completed", "failed", "pending", "pending"]);
  });

  it("keeps existing fields on a repeated tool call", () => {
    const existing = task({
      messages: [textTool({ title: "Old", name: "shell", kind: "execute", input: { a: 1 } })],
    });
    const same = update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "" }, existing);
    const part = lastMessage(same).parts[0];
    expect(part?.type === "tool" ? part.tool : undefined).toMatchObject({
      title: "Old",
      name: "shell",
      kind: "execute",
      input: { a: 1 },
    });
    const renamed = update(
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "New", name: "bash" },
      existing,
    );
    const renamedPart = lastMessage(renamed).parts[0];
    expect(renamedPart?.type === "tool" ? renamedPart.tool : undefined).toMatchObject({
      title: "New",
      name: "bash",
    });
  });

  it("returns a pending existing tool to pending", () => {
    const existing = task({ messages: [textTool({ status: "completed" })] });
    const next = update(
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "", status: "pending" },
      existing,
    );
    const part = lastMessage(next).parts[0];
    expect(part?.type === "tool" ? part.tool.status : undefined).toBe("pending");
  });

  it("defaults a bare tool call", () => {
    const next = update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "" });
    const part = lastMessage(next).parts[0];
    expect(part?.type === "tool" ? part.tool : undefined).toMatchObject({
      name: "",
      title: "",
      kind: undefined,
      status: "pending",
    });
  });

  it("updates a tool in place", () => {
    const existing = task({
      messages: [textTool({ name: "shell", kind: "execute", input: { a: 1 } })],
    });
    const next = update(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        title: "Done",
        rawOutput: { ok: true },
      },
      existing,
    );
    const part = lastMessage(next).parts[0];
    expect(part?.type === "tool" ? part.tool : undefined).toMatchObject({
      name: "shell",
      kind: "execute",
      title: "Done",
      status: "completed",
      input: { a: 1 },
      output: { ok: true },
    });
  });

  it("keeps existing fields on a sparse tool update", () => {
    const existing = task({
      messages: [
        textTool({ title: "Old", output: { old: true }, status: "completed", arguments: "abc" }),
      ],
    });
    const next = update({ sessionUpdate: "tool_call_update", toolCallId: "t1" }, existing);
    const part = lastMessage(next).parts[0];
    expect(part?.type === "tool" ? part.tool : undefined).toMatchObject({
      title: "Old",
      output: { old: true },
      status: "completed",
      arguments: "abc",
    });
  });

  it("creates an empty stub when a tool update has no fields", () => {
    const next = update({ sessionUpdate: "tool_call_update", toolCallId: "tx" });
    const part = lastMessage(next).parts[0];
    expect(part?.type === "tool" ? part.tool : undefined).toMatchObject({
      name: "",
      title: "",
      output: undefined,
      arguments: "",
      status: "pending",
    });
  });

  it("leaves other parts and tools untouched", () => {
    const existing: Task = task({
      messages: [
        {
          id: "a1",
          role: "assistant",
          createdAt: 1,
          parts: [
            { type: "text", text: "keep" },
            {
              type: "tool",
              tool: {
                toolCallId: "t1",
                name: "shell",
                title: "One",
                status: "pending",
                arguments: "",
              },
            },
            {
              type: "tool",
              tool: {
                toolCallId: "t2",
                name: "bash",
                title: "Two",
                status: "pending",
                arguments: "",
              },
            },
          ],
        },
      ],
    });
    const next = update(
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
      existing,
    );
    const parts = lastMessage(next).parts;
    expect(parts[0]).toEqual({ type: "text", text: "keep" });
    expect(parts[1]?.type === "tool" ? parts[1].tool.status : undefined).toBe("completed");
    expect(parts[2]?.type === "tool" ? parts[2].tool : undefined).toMatchObject({
      toolCallId: "t2",
      title: "Two",
    });
  });

  it("appends a tool to a message without tools", () => {
    const existing = task({ messages: [assistant([{ type: "text", text: "hi" }])] });
    const next = update(
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run", name: "shell" },
      existing,
    );
    const parts = lastMessage(next).parts;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "hi" });
    expect(parts[1]?.type === "tool" ? parts[1].tool.toolCallId : undefined).toBe("t1");
  });

  it("appends a new tool beside a different one", () => {
    const existing = task({ messages: [textTool({ toolCallId: "t2", title: "Two" })] });
    const next = update(
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "One", name: "shell" },
      existing,
    );
    const parts = lastMessage(next).parts;
    expect(parts).toHaveLength(2);
    expect(parts[0]?.type === "tool" ? parts[0].tool.toolCallId : undefined).toBe("t2");
    expect(parts[1]?.type === "tool" ? parts[1].tool : undefined).toMatchObject({
      toolCallId: "t1",
      title: "One",
    });
  });

  it("creates a stub for an unknown tool update", () => {
    const next = update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tx",
      status: "failed",
      rawOutput: "boom",
    });
    const part = lastMessage(next).parts[0];
    expect(part?.type === "tool" ? part.tool : undefined).toMatchObject({
      toolCallId: "tx",
      name: "",
      title: "",
      status: "failed",
      output: "boom",
    });
  });
});

describe("other session updates", () => {
  it("replaces the plan", () => {
    expect(
      update({
        sessionUpdate: "plan",
        entries: [{ content: "a", priority: "high", status: "pending" }],
      }).plan,
    ).toEqual([{ content: "a", priority: "high", status: "pending" }]);
  });

  it("renames the session only when a title arrives", () => {
    expect(update({ sessionUpdate: "session_info_update", title: "New" }).title).toBe("New");
    const current = task();
    expect(update({ sessionUpdate: "session_info_update" }, current)).toBe(current);
  });

  it("replaces commands and config options", () => {
    expect(
      update({ sessionUpdate: "available_commands_update", availableCommands: [1, 2] })
        .availableCommands,
    ).toEqual([1, 2]);
    expect(
      update({ sessionUpdate: "config_option_update", configOptions: [{ id: "model" }] })
        .configOptions,
    ).toEqual([{ id: "model" }]);
  });

  it("merges usage updates and ignores empty ones", () => {
    expect(update({ sessionUpdate: "usage_update", usage: { totalTokens: 3 } }).usage).toEqual({
      totalTokens: 3,
    });
    const current = task({ usage: { inputTokens: 1 } });
    expect(update({ sessionUpdate: "usage_update" }, current)).toBe(current);
  });
});

describe("x.ai session notifications", () => {
  it("completes a turn", () => {
    const next = notification(
      {
        kind: "session_notification",
        sessionId: "s1",
        update: { sessionUpdate: "turn_completed", usage: { totalTokens: 4 } },
      },
      task({ status: "running", runningPromptId: "p1" }),
    );
    expect(next.status).toBe("idle");
    expect(next.runningPromptId).toBeUndefined();
    expect(next.usage).toEqual({ totalTokens: 4 });
    expect(next.updatedAt).toBe(10);
  });

  it("merges response usage and ignores an empty one", () => {
    expect(
      notification({
        kind: "session_notification",
        sessionId: "s1",
        update: { sessionUpdate: "response_completed", usage: { inputTokens: 2 } },
      }).usage,
    ).toEqual({ inputTokens: 2 });
    const current = task();
    expect(
      notification(
        {
          kind: "session_notification",
          sessionId: "s1",
          update: { sessionUpdate: "response_completed" },
        },
        current,
      ),
    ).toBe(current);
  });

  it("accumulates tool call arguments", () => {
    const first = notification({
      kind: "session_notification",
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_delta_chunk",
        toolCallId: "t1",
        name: "shell",
        argumentsDelta: "{",
      },
    });
    const part = lastMessage(first).parts[0];
    expect(part?.type === "tool" ? part.tool : undefined).toMatchObject({
      name: "shell",
      arguments: "{",
      status: "pending",
    });
    const second = notification(
      {
        kind: "session_notification",
        sessionId: "s1",
        update: { sessionUpdate: "tool_call_delta_chunk", toolCallId: "t1", argumentsDelta: "}" },
      },
      first,
    );
    const secondPart = lastMessage(second).parts[0];
    expect(secondPart?.type === "tool" ? secondPart.tool.arguments : undefined).toBe("{}");
  });

  it("creates a bare tool for a nameless delta", () => {
    const next = notification({
      kind: "session_notification",
      sessionId: "s1",
      update: { sessionUpdate: "tool_call_delta_chunk", toolCallId: "tx" },
    });
    const part = lastMessage(next).parts[0];
    expect(part?.type === "tool" ? part.tool : undefined).toMatchObject({
      name: "",
      title: "",
      arguments: "",
    });
  });

  it("awaits a permission interaction", () => {
    expect(
      notification({
        kind: "session_notification",
        sessionId: "s1",
        update: { sessionUpdate: "pending_interaction", toolCallId: "t1", kind: "permission" },
      }).status,
    ).toBe("awaiting_permission");
    const current = task();
    expect(
      notification(
        {
          kind: "session_notification",
          sessionId: "s1",
          update: { sessionUpdate: "pending_interaction", toolCallId: "t1", kind: "other" },
        },
        current,
      ),
    ).toBe(current);
  });

  it("resolves an interaction", () => {
    expect(
      notification({
        kind: "session_notification",
        sessionId: "s1",
        update: { sessionUpdate: "interaction_resolved", toolCallId: "t1" },
      }).status,
    ).toBe("idle");
    expect(
      notification(
        {
          kind: "session_notification",
          sessionId: "s1",
          update: { sessionUpdate: "interaction_resolved", toolCallId: "t1" },
        },
        task({ runningPromptId: "c1" }),
      ).status,
    ).toBe("running");
  });

  it("ignores session summaries", () => {
    const current = task();
    expect(
      notification(
        {
          kind: "session_notification",
          sessionId: "s1",
          update: { sessionUpdate: "session_summary_generated", sessionSummary: "s" },
        },
        current,
      ),
    ).toBe(current);
  });
});

describe("queue and turn state", () => {
  it("derives the queue status without storing the agent turn id", () => {
    const running = notification({
      kind: "queue_changed",
      sessionId: "s1",
      entries: [{ id: "1", kind: "prompt", text: "hi" }],
      runningPromptId: "1",
    });
    expect(running.queue).toEqual([{ id: "1", kind: "prompt", text: "hi" }]);
    expect(running.status).toBe("running");
    expect(running.runningPromptId).toBeUndefined();
    expect(
      notification({ kind: "queue_changed", sessionId: "s1", entries: [] }, running).status,
    ).toBe("idle");
    expect(
      notification(
        { kind: "queue_changed", sessionId: "s1", entries: [] },
        task({ runningPromptId: "c1" }),
      ).status,
    ).toBe("running");
  });

  it("finishes a prompt only while a claim exists", () => {
    const running = task({ status: "running", runningPromptId: "c1" });
    expect(
      notification({ kind: "prompt_complete", sessionId: "s1", promptId: "p" }, running),
    ).toMatchObject({ status: "idle", runningPromptId: undefined });
    expect(
      notification({ kind: "prompt_complete", sessionId: "s1", promptId: "other" }, running),
    ).toMatchObject({ status: "idle", runningPromptId: undefined });
    const idle = task();
    expect(notification({ kind: "prompt_complete", sessionId: "s1" }, idle)).toBe(idle);
  });

  it("ignores task-independent notifications", () => {
    const current = task();
    expect(notification({ kind: "sessions_changed", upserted: [], removed: [] }, current)).toBe(
      current,
    );
    expect(notification({ kind: "models_update", availableModels: [] }, current)).toBe(current);
  });
});

describe("applySessionChange", () => {
  it("ignores other sessions", () => {
    const current = task();
    expect(applySessionChange(current, { sessionId: "other" }, 10)).toBe(current);
  });

  it("applies announced session fields", () => {
    const next = applySessionChange(
      task(),
      { sessionId: "s1", title: "T2", modelId: "m2", activity: "working" },
      10,
    );
    expect(next).toMatchObject({ title: "T2", model: "m2", status: "running", updatedAt: 10 });
  });

  it("applies idle activity without touching absent fields", () => {
    const next = applySessionChange(
      task({ status: "running" }),
      { sessionId: "s1", activity: "idle" },
      10,
    );
    expect(next).toMatchObject({ title: "T", model: "m", status: "idle" });
  });

  it("keeps the status for an unknown activity", () => {
    expect(
      applySessionChange(task({ status: "idle" }), { sessionId: "s1", activity: "other" }, 10)
        .status,
    ).toBe("idle");
  });
});

describe("toSummary", () => {
  it("projects the summary fields", () => {
    expect(
      toSummary(
        task({
          messages: [assistant([{ type: "text", text: "a" }])],
          usage: { totalTokens: 2 },
          lastError: "e",
        }),
      ),
    ).toEqual({
      id: "s1",
      title: "T",
      cwd: "/tmp",
      model: "m",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
      messageCount: 1,
      pendingPermission: undefined,
      usage: { totalTokens: 2 },
      lastError: "e",
      yolo: false,
    });
  });

  it("projects task detail state", () => {
    const detailed = task({
      messages: [assistant([{ type: "text", text: "a" }])],
      plan: [{ content: "step", priority: "high", status: "pending" }],
      availableCommands: ["one"],
      configOptions: ["two"],
      queue: [{ id: "q", kind: "prompt", text: "x" }],
    });
    expect(toDetail(detailed)).toMatchObject({
      id: "s1",
      messageCount: 1,
      messages: detailed.messages,
      plan: detailed.plan,
      availableCommands: ["one"],
      configOptions: ["two"],
      queue: detailed.queue,
    });
  });
});

describe("properties", () => {
  it("keeps every streamed prefix and appends exactly the chunk", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 8 }), (chunks) => {
        let current = task();
        let previous = "";
        for (const chunk of chunks) {
          current = update(
            { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } },
            current,
          );
          const part = lastMessage(current).parts[0];
          if (part?.type !== "text") throw new Error("expected a text part");
          expect(part.text.startsWith(previous)).toBe(true);
          expect(part.text).toBe(previous + chunk);
          previous = part.text;
        }
        expect(previous).toBe(chunks.join(""));
      }),
    );
  });

  it("tool updates preserve fields they do not mention", () => {
    fc.assert(
      fc.property(fc.json(), fc.string(), (rawInput, status) => {
        const created = update({
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "Run",
          name: "shell",
          kind: "execute",
          rawInput,
        });
        const updated = update(
          { sessionUpdate: "tool_call_update", toolCallId: "t1", status, title: "New" },
          created,
        );
        const part = lastMessage(updated).parts[0];
        if (part?.type !== "tool") throw new Error("expected a tool part");
        expect(part.tool.input).toEqual(rawInput);
        expect(part.tool.name).toBe("shell");
        expect(part.tool.kind).toBe("execute");
        expect(part.tool.title).toBe("New");
      }),
    );
  });
});
