import { describe, expect, it } from "vitest";
import {
  parseInitializeResult,
  parseModelState,
  parsePromptResult,
  parseServerNotification,
  parseSessionNewResult,
  parseSessionUpdate,
  parseUsage,
} from "./session.ts";

describe("parseUsage", () => {
  it("reads camelCase counters", () => {
    expect(
      parseUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3, reasoningTokens: 4 }),
    ).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3, reasoningTokens: 4 });
  });

  it("reads snake_case counters", () => {
    expect(
      parseUsage({ input_tokens: 1, output_tokens: 2, total_tokens: 3, reasoning_tokens: 4 }),
    ).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3, reasoningTokens: 4 });
  });

  it("prefers camelCase over snake_case", () => {
    expect(parseUsage({ inputTokens: 1, input_tokens: 9 })).toEqual({
      inputTokens: 1,
      outputTokens: undefined,
      totalTokens: undefined,
      reasoningTokens: undefined,
    });
  });

  it("returns undefined fields for an object without counters", () => {
    expect(parseUsage({})).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      reasoningTokens: undefined,
    });
  });

  it("rejects non-objects", () => {
    expect(parseUsage(3)).toBeUndefined();
  });
});

describe("parseModelState", () => {
  it("rejects non-objects", () => {
    expect(parseModelState("x")).toBeUndefined();
  });

  it("parses models with modelId, id or neither", () => {
    expect(
      parseModelState({
        currentModelId: "m1",
        availableModels: [{ modelId: "a", name: "A" }, { id: "b" }, {}, "x"],
      }),
    ).toEqual({
      currentModelId: "m1",
      availableModels: [
        { modelId: "a", name: "A" },
        { modelId: "b", name: undefined },
        { modelId: "" },
      ],
    });
  });

  it("treats a missing model list as empty", () => {
    expect(parseModelState({})).toEqual({ currentModelId: undefined, availableModels: [] });
  });
});

describe("parseInitializeResult", () => {
  it("fills defaults for missing fields", () => {
    expect(parseInitializeResult({})).toEqual({
      protocolVersion: undefined,
      agentCapabilities: {},
      authMethods: [],
      currentWorkingDirectory: undefined,
      modelState: undefined,
      availableCommands: [],
    });
  });

  it("tolerates a non-object payload", () => {
    expect(parseInitializeResult("nope").agentCapabilities).toEqual({});
  });

  it("reads initialize metadata", () => {
    expect(
      parseInitializeResult({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: ["a"],
        _meta: {
          currentWorkingDirectory: "/tmp",
          modelState: { currentModelId: "m", availableModels: [{ modelId: "m" }] },
          availableCommands: [{ name: "help" }],
        },
      }),
    ).toEqual({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: ["a"],
      currentWorkingDirectory: "/tmp",
      modelState: { currentModelId: "m", availableModels: [{ modelId: "m", name: undefined }] },
      availableCommands: [{ name: "help" }],
    });
  });
});

describe("parseSessionNewResult", () => {
  it("requires a session id", () => {
    expect(parseSessionNewResult({})).toBeUndefined();
    expect(parseSessionNewResult("x")).toBeUndefined();
  });

  it("parses models and config options", () => {
    expect(
      parseSessionNewResult({
        sessionId: "s",
        models: { currentModelId: "m", availableModels: [] },
        configOptions: [{ id: "model", name: "Model" }, { id: "x" }, { name: "no id" }, 4],
      }),
    ).toEqual({
      sessionId: "s",
      models: { currentModelId: "m", availableModels: [] },
      configOptions: [
        { id: "model", name: "Model" },
        { id: "x", name: undefined },
        { id: "", name: "no id" },
      ],
    });
  });

  it("defaults absent collections", () => {
    expect(parseSessionNewResult({ sessionId: "s" })).toEqual({
      sessionId: "s",
      models: undefined,
      configOptions: [],
    });
  });
});

describe("parsePromptResult", () => {
  it("defaults empty results", () => {
    expect(parsePromptResult({})).toEqual({ stopReason: undefined, usage: undefined });
    expect(parsePromptResult(1)).toEqual({ stopReason: undefined, usage: undefined });
  });

  it("reads usage from the result or _meta", () => {
    expect(parsePromptResult({ stopReason: "end_turn", usage: { totalTokens: 5 } })).toEqual({
      stopReason: "end_turn",
      usage: {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: 5,
        reasoningTokens: undefined,
      },
    });
    expect(parsePromptResult({ _meta: { usage: { inputTokens: 2 } } }).usage?.inputTokens).toBe(2);
  });

  it("prefers result usage over _meta usage", () => {
    expect(
      parsePromptResult({ usage: { totalTokens: 1 }, _meta: { usage: { totalTokens: 2 } } }).usage
        ?.totalTokens,
    ).toBe(1);
  });
});

describe("parseSessionUpdate", () => {
  it("rejects non-objects and missing tags", () => {
    expect(parseSessionUpdate("x")).toBeUndefined();
    expect(parseSessionUpdate({})).toBeUndefined();
    expect(parseSessionUpdate({ sessionUpdate: 1 })).toBeUndefined();
    expect(parseSessionUpdate({ sessionUpdate: "nope" })).toBeUndefined();
  });

  it("parses message chunks with and without message ids", () => {
    expect(
      parseSessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" },
        messageId: "m",
      }),
    ).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
      messageId: "m",
    });
    expect(
      parseSessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" },
      }),
    ).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
      messageId: undefined,
    });
  });

  it("parses thought chunks", () => {
    expect(
      parseSessionUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "hmm" },
      }),
    ).toEqual({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "hmm" },
      messageId: undefined,
    });
  });

  it("rejects malformed chunks", () => {
    expect(parseSessionUpdate({ sessionUpdate: "agent_message_chunk" })).toBeUndefined();
    expect(
      parseSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "image" } }),
    ).toBeUndefined();
  });

  it("parses tool calls", () => {
    expect(
      parseSessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "t",
        title: "Run",
        name: "shell",
        kind: "execute",
        status: "pending",
        rawInput: { command: "ls" },
      }),
    ).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "t",
      title: "Run",
      name: "shell",
      kind: "execute",
      status: "pending",
      rawInput: { command: "ls" },
    });
  });

  it("defaults a tool call without extra fields", () => {
    expect(parseSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t" })).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "t",
      title: "",
      name: undefined,
      kind: undefined,
      status: undefined,
      rawInput: undefined,
    });
    expect(parseSessionUpdate({ sessionUpdate: "tool_call", title: "x" })).toBeUndefined();
  });

  it("parses tool call updates", () => {
    expect(
      parseSessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "t",
        status: "completed",
        title: "Done",
        rawOutput: { ok: true },
      }),
    ).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      status: "completed",
      title: "Done",
      rawOutput: { ok: true },
    });
    expect(parseSessionUpdate({ sessionUpdate: "tool_call_update", status: "x" })).toBeUndefined();
  });

  it("parses plans and skips invalid entries", () => {
    expect(
      parseSessionUpdate({
        sessionUpdate: "plan",
        entries: [{ content: "a", priority: "high", status: "pending" }, 4, {}],
      }),
    ).toEqual({
      sessionUpdate: "plan",
      entries: [
        { content: "a", priority: "high", status: "pending" },
        { content: "", priority: "", status: "" },
      ],
    });
    expect(parseSessionUpdate({ sessionUpdate: "plan" })).toBeUndefined();
    expect(parseSessionUpdate({ sessionUpdate: "plan", entries: {} })).toBeUndefined();
  });

  it("parses session info updates", () => {
    expect(parseSessionUpdate({ sessionUpdate: "session_info_update", title: "T" })).toEqual({
      sessionUpdate: "session_info_update",
      title: "T",
    });
    expect(parseSessionUpdate({ sessionUpdate: "session_info_update" })).toEqual({
      sessionUpdate: "session_info_update",
      title: undefined,
    });
  });

  it("parses command and config option updates", () => {
    expect(
      parseSessionUpdate({ sessionUpdate: "available_commands_update", availableCommands: [1] }),
    ).toEqual({ sessionUpdate: "available_commands_update", availableCommands: [1] });
    expect(parseSessionUpdate({ sessionUpdate: "available_commands_update" })).toEqual({
      sessionUpdate: "available_commands_update",
      availableCommands: [],
    });
    expect(
      parseSessionUpdate({ sessionUpdate: "config_option_update", configOptions: [1] }),
    ).toEqual({ sessionUpdate: "config_option_update", configOptions: [1] });
    expect(parseSessionUpdate({ sessionUpdate: "config_option_update" })).toEqual({
      sessionUpdate: "config_option_update",
      configOptions: [],
    });
  });

  it("parses usage updates", () => {
    expect(
      parseSessionUpdate({
        sessionUpdate: "usage_update",
        usage: { totalTokens: 9 },
        used: 1,
        size: 2,
      }),
    ).toEqual({
      sessionUpdate: "usage_update",
      usage: {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: 9,
        reasoningTokens: undefined,
      },
      used: 1,
      size: 2,
    });
    expect(parseSessionUpdate({ sessionUpdate: "usage_update" })).toEqual({
      sessionUpdate: "usage_update",
      usage: undefined,
      used: undefined,
      size: undefined,
    });
  });
});

describe("parseServerNotification", () => {
  it("parses session updates", () => {
    expect(
      parseServerNotification("session/update", {
        sessionId: "s",
        update: { sessionUpdate: "session_info_update", title: "T" },
      }),
    ).toEqual({
      kind: "session_update",
      sessionId: "s",
      update: { sessionUpdate: "session_info_update", title: "T" },
    });
  });

  it("rejects malformed session updates", () => {
    expect(
      parseServerNotification("session/update", { update: { sessionUpdate: "plan", entries: [] } }),
    ).toBeUndefined();
    expect(parseServerNotification("session/update", { sessionId: "s" })).toBeUndefined();
    expect(
      parseServerNotification("session/update", { sessionId: "s", update: {} }),
    ).toBeUndefined();
    expect(parseServerNotification("session/update", "x")).toBeUndefined();
    expect(
      parseServerNotification("session/update", {
        update: { sessionUpdate: "session_info_update", title: "T" },
      }),
    ).toBeUndefined();
  });

  it("parses turn and response completions", () => {
    expect(
      parseServerNotification("x.ai/session_notification", {
        sessionId: "s",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "p",
          stop_reason: "end_turn",
          usage: { total_tokens: 3 },
        },
      }),
    ).toEqual({
      kind: "session_notification",
      sessionId: "s",
      update: {
        sessionUpdate: "turn_completed",
        promptId: "p",
        stopReason: "end_turn",
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: 3,
          reasoningTokens: undefined,
        },
      },
    });
    expect(
      parseServerNotification("_x.ai/session_notification", {
        sessionId: "s",
        update: { sessionUpdate: "response_completed", usage: { input_tokens: 2 } },
      }),
    ).toEqual({
      kind: "session_notification",
      sessionId: "s",
      update: {
        sessionUpdate: "response_completed",
        usage: {
          inputTokens: 2,
          outputTokens: undefined,
          totalTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    });
  });

  it("parses tool call deltas", () => {
    expect(
      parseServerNotification("x.ai/session_notification", {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call_delta_chunk",
          tool_call_id: "t",
          name: "shell",
          arguments_delta: "{",
        },
      }),
    ).toEqual({
      kind: "session_notification",
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_delta_chunk",
        toolCallId: "t",
        name: "shell",
        argumentsDelta: "{",
      },
    });
    expect(
      parseServerNotification("x.ai/session_notification", {
        sessionId: "s",
        update: { sessionUpdate: "tool_call_delta_chunk" },
      }),
    ).toBeUndefined();
  });

  it("parses pending interactions and resolutions", () => {
    expect(
      parseServerNotification("x.ai/session_notification", {
        sessionId: "s",
        update: { sessionUpdate: "pending_interaction", tool_call_id: "t", kind: "permission" },
      }),
    ).toEqual({
      kind: "session_notification",
      sessionId: "s",
      update: { sessionUpdate: "pending_interaction", toolCallId: "t", kind: "permission" },
    });
    expect(
      parseServerNotification("x.ai/session_notification", {
        sessionId: "s",
        update: { sessionUpdate: "pending_interaction", tool_call_id: "t" },
      }),
    ).toEqual({
      kind: "session_notification",
      sessionId: "s",
      update: { sessionUpdate: "pending_interaction", toolCallId: "t", kind: "" },
    });
    expect(
      parseServerNotification("x.ai/session_notification", {
        sessionId: "s",
        update: { sessionUpdate: "pending_interaction" },
      }),
    ).toBeUndefined();
    expect(
      parseServerNotification("x.ai/session_notification", {
        sessionId: "s",
        update: { sessionUpdate: "interaction_resolved", tool_call_id: "t" },
      }),
    ).toEqual({
      kind: "session_notification",
      sessionId: "s",
      update: { sessionUpdate: "interaction_resolved", toolCallId: "t" },
    });
    expect(
      parseServerNotification("x.ai/session_notification", {
        sessionId: "s",
        update: { sessionUpdate: "interaction_resolved" },
      }),
    ).toBeUndefined();
  });

  it("parses session summaries", () => {
    expect(
      parseServerNotification("x.ai/session_notification", {
        sessionId: "s",
        update: { sessionUpdate: "session_summary_generated", session_summary: "sum" },
      }),
    ).toEqual({
      kind: "session_notification",
      sessionId: "s",
      update: { sessionUpdate: "session_summary_generated", sessionSummary: "sum" },
    });
    expect(
      parseServerNotification("x.ai/session_notification", {
        sessionId: "s",
        update: { sessionUpdate: "session_summary_generated" },
      }),
    ).toEqual({
      kind: "session_notification",
      sessionId: "s",
      update: { sessionUpdate: "session_summary_generated", sessionSummary: undefined },
    });
  });

  it("rejects malformed session notifications", () => {
    expect(parseServerNotification("x.ai/session_notification", {})).toBeUndefined();
    expect(
      parseServerNotification("x.ai/session_notification", { sessionId: "s" }),
    ).toBeUndefined();
    expect(
      parseServerNotification("x.ai/session_notification", {
        sessionId: "s",
        update: { sessionUpdate: "unknown" },
      }),
    ).toBeUndefined();
    expect(
      parseServerNotification("x.ai/session_notification", { sessionId: "s", update: 1 }),
    ).toBeUndefined();
    expect(parseServerNotification("x.ai/session_notification", "x")).toBeUndefined();
    expect(
      parseServerNotification("x.ai/session_notification", {
        update: { sessionUpdate: "turn_completed" },
      }),
    ).toBeUndefined();
  });

  it("parses queue changes", () => {
    expect(
      parseServerNotification("_x.ai/queue/changed", {
        sessionId: "s",
        entries: [{ id: "1", kind: "prompt", text: "hi" }, 3, {}],
        runningPromptId: "1",
      }),
    ).toEqual({
      kind: "queue_changed",
      sessionId: "s",
      entries: [
        { id: "1", kind: "prompt", text: "hi" },
        { id: "", kind: "", text: "" },
      ],
      runningPromptId: "1",
    });
    expect(parseServerNotification("x.ai/queue/changed", { sessionId: "s", entries: [] })).toEqual({
      kind: "queue_changed",
      sessionId: "s",
      entries: [],
      runningPromptId: undefined,
    });
    expect(parseServerNotification("x.ai/queue/changed", { entries: [] })).toBeUndefined();
    expect(parseServerNotification("x.ai/queue/changed", "x")).toBeUndefined();
    expect(parseServerNotification("x.ai/queue/changed", { runningPromptId: "p" })).toBeUndefined();
    expect(parseServerNotification("x.ai/queue/changed", { sessionId: "s" })).toEqual({
      kind: "queue_changed",
      sessionId: "s",
      entries: [],
      runningPromptId: undefined,
    });
  });

  it("parses session changes", () => {
    expect(
      parseServerNotification("_x.ai/sessions/changed", {
        upserted: [
          { sessionId: "a", title: "T", cwd: "/tmp", activity: "working", modelId: "m" },
          { title: "no id" },
        ],
        removed: ["b"],
      }),
    ).toEqual({
      kind: "sessions_changed",
      upserted: [{ sessionId: "a", title: "T", cwd: "/tmp", activity: "working", modelId: "m" }],
      removed: ["b"],
    });
    expect(parseServerNotification("x.ai/sessions/changed", {})).toEqual({
      kind: "sessions_changed",
      upserted: [],
      removed: [],
    });
    expect(parseServerNotification("x.ai/sessions/changed", "x")).toBeUndefined();
    expect(parseServerNotification("x.ai/sessions/changed", { upserted: ["x", 1] })).toEqual({
      kind: "sessions_changed",
      upserted: [],
      removed: [],
    });
  });

  it("parses prompt completions", () => {
    expect(
      parseServerNotification("_x.ai/session/prompt_complete", {
        sessionId: "s",
        promptId: "p",
        stopReason: "end_turn",
      }),
    ).toEqual({
      kind: "prompt_complete",
      sessionId: "s",
      promptId: "p",
      stopReason: "end_turn",
    });
    expect(parseServerNotification("x.ai/session/prompt_complete", { sessionId: "s" })).toEqual({
      kind: "prompt_complete",
      sessionId: "s",
      promptId: undefined,
      stopReason: undefined,
    });
    expect(parseServerNotification("x.ai/session/prompt_complete", {})).toBeUndefined();
    expect(parseServerNotification("x.ai/session/prompt_complete", "x")).toBeUndefined();
    expect(
      parseServerNotification("x.ai/session/prompt_complete", { promptId: "p" }),
    ).toBeUndefined();
  });

  it("parses model updates", () => {
    expect(
      parseServerNotification("_x.ai/models/update", {
        currentModelId: "m",
        availableModels: [{ modelId: "m", name: "M" }],
      }),
    ).toEqual({
      kind: "models_update",
      currentModelId: "m",
      availableModels: [{ modelId: "m", name: "M" }],
    });
    expect(parseServerNotification("x.ai/models/update", {})).toEqual({
      kind: "models_update",
      currentModelId: undefined,
      availableModels: [],
    });
    expect(parseServerNotification("x.ai/models/update", "x")).toBeUndefined();
  });

  it("ignores unknown methods", () => {
    expect(parseServerNotification("session/unknown", {})).toBeUndefined();
    expect(parseServerNotification("_x.ai/unknown", {})).toBeUndefined();
  });
});
