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

const runId = "run-1";

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
  let state = emptyAgUiState(runId);
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
  const started = new Set<string>();
  const ended = new Set<string>();
  const bump = (key: string, delta: number): void => {
    const next = (depth.get(key) ?? 0) + delta;
    expect(next).toBeGreaterThanOrEqual(0);
    depth.set(key, next);
  };
  for (const event of events) {
    switch (event.type) {
      case "TEXT_MESSAGE_START":
        bump(`t:${event.messageId}`, 1);
        started.add(`t:${event.messageId}`);
        break;
      case "TEXT_MESSAGE_END":
        bump(`t:${event.messageId}`, -1);
        ended.add(`t:${event.messageId}`);
        break;
      case "REASONING_MESSAGE_START":
        bump(`r:${event.messageId}`, 1);
        started.add(`r:${event.messageId}`);
        break;
      case "REASONING_MESSAGE_END":
        bump(`r:${event.messageId}`, -1);
        ended.add(`r:${event.messageId}`);
        break;
      case "TOOL_CALL_START":
        bump(`c:${event.toolCallId}`, 1);
        started.add(`c:${event.toolCallId}`);
        break;
      case "TOOL_CALL_END":
        bump(`c:${event.toolCallId}`, -1);
        ended.add(`c:${event.toolCallId}`);
        break;
      case "TOOL_CALL_RESULT":
        expect(ended.has(`c:${event.toolCallId}`)).toBe(true);
        break;
      default:
        break;
    }
  }
  for (const value of depth.values()) expect(value).toBe(0);
  expect([...started].sort()).toEqual([...ended].sort());
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
  it("opens a run-scoped text message and appends deltas", () => {
    const first = mapSessionUpdate(emptyAgUiState(runId), text("a"));
    expect(first.events).toEqual([
      { type: "TEXT_MESSAGE_START", messageId: `${runId}-text`, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: `${runId}-text`, delta: "a" },
    ]);
    const second = mapSessionUpdate(first.state, text("b"));
    expect(second.events).toEqual([
      { type: "TEXT_MESSAGE_CONTENT", messageId: `${runId}-text`, delta: "b" },
    ]);
    expect(second.state).toEqual({ ...first.state });
  });

  it("uses distinct fallback ids per run", () => {
    const first = mapSessionUpdate(emptyAgUiState("run-a"), text("a"));
    const second = mapSessionUpdate(emptyAgUiState("run-b"), text("b"));
    expect(first.events[0]).toMatchObject({ messageId: "run-a-text" });
    expect(second.events[0]).toMatchObject({ messageId: "run-b-text" });
  });

  it("reuses the open message id when a chunk has none", () => {
    const first = mapSessionUpdate(emptyAgUiState(runId), text("a", "m1"));
    const second = mapSessionUpdate(first.state, text("b"));
    expect(second.events).toEqual([{ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "b" }]);
  });

  it("closes the open message when the id changes", () => {
    const first = mapSessionUpdate(emptyAgUiState(runId), text("a", "m1"));
    const second = mapSessionUpdate(first.state, text("b", "m2"));
    expect(second.events).toEqual([
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
      { type: "TEXT_MESSAGE_START", messageId: "m2", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m2", delta: "b" },
    ]);
  });
});

describe("thought chunks", () => {
  it("opens a run-scoped reasoning message and appends deltas", () => {
    const first = mapSessionUpdate(emptyAgUiState(runId), thought("a"));
    expect(first.events).toEqual([
      { type: "REASONING_MESSAGE_START", messageId: `${runId}-reasoning`, role: "reasoning" },
      { type: "REASONING_MESSAGE_CONTENT", messageId: `${runId}-reasoning`, delta: "a" },
    ]);
    expect(mapSessionUpdate(first.state, thought("b")).events).toEqual([
      { type: "REASONING_MESSAGE_CONTENT", messageId: `${runId}-reasoning`, delta: "b" },
    ]);
  });

  it("uses and switches explicit reasoning ids", () => {
    const first = mapSessionUpdate(emptyAgUiState(runId), thought("a", "r1"));
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
    const mapped = mapSessionUpdate(
      emptyAgUiState(runId),
      toolCall("t1", "shell", { command: "ls" }),
    );
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
    expect(mapSessionUpdate(emptyAgUiState(runId), toolCall("t1")).events).toEqual([
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
    const textState = mapSessionUpdate(emptyAgUiState(runId), text("a", "m1")).state;
    expect(mapSessionUpdate(textState, toolCall("t1", "shell")).events[0]).toMatchObject({
      parentMessageId: "m1",
    });
  });

  it("treats a repeated tool call as a no-op", () => {
    const opened = mapSessionUpdate(emptyAgUiState(runId), toolCall("t1", "shell"));
    const repeated = mapSessionUpdate(opened.state, toolCall("t1"));
    expect(repeated.events).toEqual([]);
    expect(repeated.state).toBe(opened.state);
  });

  it("closes a tool call with its run-scoped result", () => {
    const opened = mapSessionUpdate(emptyAgUiState(runId), toolCall("t1", "shell"));
    const closed = mapSessionUpdate(opened.state, toolUpdate("t1", "completed", { ok: true }));
    expect(closed.events).toEqual([
      { type: "TOOL_CALL_END", toolCallId: "t1" },
      {
        type: "TOOL_CALL_RESULT",
        messageId: `${runId}-tool-t1`,
        toolCallId: "t1",
        content: '{"ok":true}',
        role: "tool",
      },
    ]);
    expect(closed.state.openTools).toEqual([]);
  });

  it("uses empty content for a result without output", () => {
    const opened = mapSessionUpdate(emptyAgUiState(runId), toolCall("t1", "shell"));
    const closed = mapSessionUpdate(opened.state, toolUpdate("t1", "failed"));
    expect(closed.events[1]).toEqual({
      type: "TOOL_CALL_RESULT",
      messageId: `${runId}-tool-t1`,
      toolCallId: "t1",
      content: "",
      role: "tool",
    });
  });

  it("ignores updates for unknown tools and open statuses", () => {
    const opened = mapSessionUpdate(emptyAgUiState(runId), toolCall("t1", "shell"));
    const unknown = mapSessionUpdate(opened.state, toolUpdate("tx", "completed"));
    expect(unknown.events).toEqual([]);
    const open = mapSessionUpdate(opened.state, toolUpdate("t1", "in_progress"));
    expect(open.events).toEqual([]);
    expect(open.state).toBe(opened.state);
  });
});

describe("finishTurn", () => {
  it("closes every open stream", () => {
    let state: AgUiMapperState = emptyAgUiState(runId);
    for (const update of [
      text("a"),
      thought("b"),
      toolCall("t1", "shell"),
      toolCall("t2", "shell"),
    ]) {
      state = mapSessionUpdate(state, update).state;
    }
    expect(finishTurn(state).events).toEqual([
      { type: "TEXT_MESSAGE_END", messageId: `${runId}-text` },
      { type: "REASONING_MESSAGE_END", messageId: `${runId}-reasoning` },
      { type: "TOOL_CALL_END", toolCallId: "t1" },
      { type: "TOOL_CALL_END", toolCallId: "t2" },
    ]);
    expect(finishTurn(state).state).toEqual(emptyAgUiState(runId));
  });

  it("emits nothing for an empty state", () => {
    expect(finishTurn(emptyAgUiState(runId))).toEqual({
      state: emptyAgUiState(runId),
      events: [],
    });
  });
});

describe("ignored updates", () => {
  it("returns the same state", () => {
    const state = emptyAgUiState(runId);
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
  it("emits balanced start and end events and a result for every closed tool", () => {
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
