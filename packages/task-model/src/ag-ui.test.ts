import type { SessionUpdate } from "@grok-build-web/acp-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  emptyAgUiState,
  errorRun,
  finishRun,
  finishTurn,
  mapSessionUpdate,
  startRun,
  type AgUiEvent,
  type AgUiMapperState,
} from "./ag-ui.ts";

const text = (value: string, messageId?: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: value },
  messageId,
});

const thought = (value: string, messageId?: string): SessionUpdate => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text: value },
  messageId,
});

const toolCall = (toolCallId: string, name?: string, rawInput?: unknown): SessionUpdate => ({
  sessionUpdate: "tool_call",
  toolCallId,
  title: "Run",
  name,
  rawInput,
});

const toolUpdate = (toolCallId: string, status: string, rawOutput?: unknown): SessionUpdate => ({
  sessionUpdate: "tool_call_update",
  toolCallId,
  status,
  rawOutput,
});

const eventsOf = (updates: readonly SessionUpdate[]): readonly AgUiEvent[] => {
  let state = emptyAgUiState();
  const events: AgUiEvent[] = [];
  for (const update of updates) {
    const mapped = mapSessionUpdate(state, update);
    events.push(...mapped.events);
    state = mapped.state;
  }
  events.push(...finishTurn(state).events);
  return events;
};

const assertBalanced = (events: readonly AgUiEvent[]): void => {
  const depth = new Map<string, number>();
  for (const event of events) {
    if (event.type === "TEXT_MESSAGE_START") {
      depth.set(event.messageId, (depth.get(event.messageId) ?? 0) + 1);
    }
    if (event.type === "TEXT_MESSAGE_END") {
      depth.set(event.messageId, (depth.get(event.messageId) ?? 0) - 1);
    }
    if (event.type === "REASONING_MESSAGE_START") {
      depth.set(`r:${event.messageId}`, (depth.get(`r:${event.messageId}`) ?? 0) + 1);
    }
    if (event.type === "REASONING_MESSAGE_END") {
      depth.set(`r:${event.messageId}`, (depth.get(`r:${event.messageId}`) ?? 0) - 1);
    }
    if (event.type === "TOOL_CALL_START") {
      depth.set(`t:${event.toolCallId}`, (depth.get(`t:${event.toolCallId}`) ?? 0) + 1);
    }
    if (event.type === "TOOL_CALL_END") {
      depth.set(`t:${event.toolCallId}`, (depth.get(`t:${event.toolCallId}`) ?? 0) - 1);
    }
  }
  for (const value of depth.values()) expect(value).toBe(0);
};

describe("run events", () => {
  it("starts, finishes and fails runs", () => {
    expect(startRun("th", "run")).toEqual({ type: "RUN_STARTED", threadId: "th", runId: "run" });
    expect(finishRun("th", "run", { totalTokens: 1 })).toEqual({
      type: "RUN_FINISHED",
      threadId: "th",
      runId: "run",
      usage: [{ totalTokens: 1 }],
    });
    expect(finishRun("th", "run", undefined)).toEqual({
      type: "RUN_FINISHED",
      threadId: "th",
      runId: "run",
      usage: [],
    });
    expect(errorRun("bad")).toEqual({ type: "RUN_ERROR", message: "bad", code: undefined });
    expect(errorRun("bad", "E")).toEqual({ type: "RUN_ERROR", message: "bad", code: "E" });
  });
});

describe("text chunks", () => {
  it("opens a text message and appends deltas", () => {
    const first = mapSessionUpdate(emptyAgUiState(), text("a"));
    expect(first.events).toEqual([
      { type: "TEXT_MESSAGE_START", messageId: "assistant", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant", delta: "a" },
    ]);
    const second = mapSessionUpdate(first.state, text("b"));
    expect(second.events).toEqual([
      { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant", delta: "b" },
    ]);
    expect(second.state).toEqual({ ...first.state });
  });

  it("reuses the open message id when a chunk has none", () => {
    const first = mapSessionUpdate(emptyAgUiState(), text("a", "m1"));
    const second = mapSessionUpdate(first.state, text("b"));
    expect(second.events).toEqual([{ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "b" }]);
  });

  it("closes the open message when the id changes", () => {
    const first = mapSessionUpdate(emptyAgUiState(), text("a", "m1"));
    const second = mapSessionUpdate(first.state, text("b", "m2"));
    expect(second.events).toEqual([
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
      { type: "TEXT_MESSAGE_START", messageId: "m2", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m2", delta: "b" },
    ]);
  });
});

describe("thought chunks", () => {
  it("opens a reasoning message and appends deltas", () => {
    const first = mapSessionUpdate(emptyAgUiState(), thought("a"));
    expect(first.events).toEqual([
      { type: "REASONING_MESSAGE_START", messageId: "reasoning", role: "reasoning" },
      { type: "REASONING_MESSAGE_CONTENT", messageId: "reasoning", delta: "a" },
    ]);
    expect(mapSessionUpdate(first.state, thought("b")).events).toEqual([
      { type: "REASONING_MESSAGE_CONTENT", messageId: "reasoning", delta: "b" },
    ]);
  });

  it("uses and switches explicit reasoning ids", () => {
    const first = mapSessionUpdate(emptyAgUiState(), thought("a", "r1"));
    expect(first.state.reasoningMessageId).toBe("r1");
    expect(mapSessionUpdate(first.state, thought("b")).state.reasoningMessageId).toBe("r1");
    expect(mapSessionUpdate(first.state, thought("b", "r2")).events).toEqual([
      { type: "REASONING_MESSAGE_END", messageId: "r1" },
      { type: "REASONING_MESSAGE_START", messageId: "r2", role: "reasoning" },
      { type: "REASONING_MESSAGE_CONTENT", messageId: "r2", delta: "b" },
    ]);
  });
});

describe("tool calls", () => {
  it("starts a tool call with its arguments", () => {
    const mapped = mapSessionUpdate(emptyAgUiState(), toolCall("t1", "shell", { command: "ls" }));
    expect(mapped.events).toEqual([
      {
        type: "TOOL_CALL_START",
        toolCallId: "t1",
        toolCallName: "shell",
        parentMessageId: undefined,
      },
      { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '{"command":"ls"}' },
    ]);
    expect(mapped.state.openTools).toEqual(["t1"]);
  });

  it("falls back to the title and empty input", () => {
    expect(mapSessionUpdate(emptyAgUiState(), toolCall("t1")).events).toEqual([
      {
        type: "TOOL_CALL_START",
        toolCallId: "t1",
        toolCallName: "Run",
        parentMessageId: undefined,
      },
      { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: "{}" },
    ]);
  });

  it("attaches the open text message as parent", () => {
    const textState = mapSessionUpdate(emptyAgUiState(), text("a", "m1")).state;
    expect(mapSessionUpdate(textState, toolCall("t1", "shell")).events[0]).toMatchObject({
      parentMessageId: "m1",
    });
  });

  it("does not restart an open tool call", () => {
    const opened = mapSessionUpdate(emptyAgUiState(), toolCall("t1", "shell"));
    expect(mapSessionUpdate(opened.state, toolCall("t1")).events).toEqual([
      { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: "{}" },
    ]);
  });

  it("closes a tool call with its result", () => {
    const opened = mapSessionUpdate(emptyAgUiState(), toolCall("t1", "shell"));
    const closed = mapSessionUpdate(opened.state, toolUpdate("t1", "completed", { ok: true }));
    expect(closed.events).toEqual([
      { type: "TOOL_CALL_END", toolCallId: "t1" },
      {
        type: "TOOL_CALL_RESULT",
        messageId: "tool-t1",
        toolCallId: "t1",
        content: '{"ok":true}',
        role: "tool",
      },
    ]);
    expect(closed.state.openTools).toEqual([]);
  });

  it("uses empty content for a result without output", () => {
    const opened = mapSessionUpdate(emptyAgUiState(), toolCall("t1", "shell"));
    const closed = mapSessionUpdate(opened.state, toolUpdate("t1", "failed"));
    expect(closed.events[1]).toEqual({
      type: "TOOL_CALL_RESULT",
      messageId: "tool-t1",
      toolCallId: "t1",
      content: "",
      role: "tool",
    });
  });

  it("ignores updates for unknown tools and open statuses", () => {
    const opened = mapSessionUpdate(emptyAgUiState(), toolCall("t1", "shell"));
    const unknown = mapSessionUpdate(opened.state, toolUpdate("tx", "completed"));
    expect(unknown.events).toEqual([]);
    const open = mapSessionUpdate(opened.state, toolUpdate("t1", "in_progress"));
    expect(open.events).toEqual([]);
    expect(open.state).toBe(opened.state);
  });
});

describe("finishTurn", () => {
  it("closes every open stream", () => {
    let state: AgUiMapperState = emptyAgUiState();
    for (const update of [
      text("a"),
      thought("b"),
      toolCall("t1", "shell"),
      toolCall("t2", "shell"),
    ]) {
      state = mapSessionUpdate(state, update).state;
    }
    expect(finishTurn(state).events).toEqual([
      { type: "TEXT_MESSAGE_END", messageId: "assistant" },
      { type: "REASONING_MESSAGE_END", messageId: "reasoning" },
      { type: "TOOL_CALL_END", toolCallId: "t1" },
      { type: "TOOL_CALL_END", toolCallId: "t2" },
    ]);
    expect(finishTurn(state).state).toEqual(emptyAgUiState());
  });

  it("emits nothing for an empty state", () => {
    expect(finishTurn(emptyAgUiState())).toEqual({ state: emptyAgUiState(), events: [] });
  });
});

describe("ignored updates", () => {
  it("returns the same state", () => {
    const state = emptyAgUiState();
    for (const update of [
      { sessionUpdate: "plan", entries: [] },
      { sessionUpdate: "session_info_update" },
      { sessionUpdate: "usage_update" },
    ] as const) {
      const mapped = mapSessionUpdate(state, update);
      expect(mapped.events).toEqual([]);
      expect(mapped.state).toBe(state);
    }
  });
});

describe("properties", () => {
  it("emits balanced start and end events for any update sequence", () => {
    const updateArbitrary = fc.oneof(
      fc.record({
        kind: fc.constant("text" as const),
        value: fc.string(),
        id: fc.option(fc.constantFrom("m1", "m2"), { nil: undefined }),
      }),
      fc.record({
        kind: fc.constant("thought" as const),
        value: fc.string(),
        id: fc.option(fc.constantFrom("r1", "r2"), { nil: undefined }),
      }),
      fc.record({
        kind: fc.constant("call" as const),
        value: fc.constant(""),
        id: fc.constantFrom("t1", "t2"),
      }),
      fc.record({
        kind: fc.constant("update" as const),
        value: fc.constant(""),
        id: fc.constantFrom("t1", "t2"),
        status: fc.constantFrom("completed", "failed", "in_progress"),
        output: fc.json(),
      }),
    );
    fc.assert(
      fc.property(fc.array(updateArbitrary, { maxLength: 12 }), (sequence) => {
        const updates: SessionUpdate[] = sequence.map((item) => {
          switch (item.kind) {
            case "text":
              return text(item.value, item.id);
            case "thought":
              return thought(item.value, item.id);
            case "call":
              return toolCall(item.id, "shell");
            case "update":
              return toolUpdate(item.id, item.status, item.output);
          }
        });
        assertBalanced(eventsOf(updates));
      }),
    );
  });
});
