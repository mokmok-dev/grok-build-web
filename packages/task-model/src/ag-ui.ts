import type { SessionUpdate, Usage } from "@grok-build-web/acp-protocol";

export type AgUiEvent =
  | { readonly type: "RUN_STARTED"; readonly threadId: string; readonly runId: string }
  | {
      readonly type: "TEXT_MESSAGE_START";
      readonly messageId: string;
      readonly role: "assistant";
    }
  | { readonly type: "TEXT_MESSAGE_CONTENT"; readonly messageId: string; readonly delta: string }
  | { readonly type: "TEXT_MESSAGE_END"; readonly messageId: string }
  | {
      readonly type: "REASONING_MESSAGE_START";
      readonly messageId: string;
      readonly role: "reasoning";
    }
  | {
      readonly type: "REASONING_MESSAGE_CONTENT";
      readonly messageId: string;
      readonly delta: string;
    }
  | { readonly type: "REASONING_MESSAGE_END"; readonly messageId: string }
  | {
      readonly type: "TOOL_CALL_START";
      readonly toolCallId: string;
      readonly toolCallName: string;
      readonly parentMessageId?: string;
    }
  | { readonly type: "TOOL_CALL_ARGS"; readonly toolCallId: string; readonly delta: string }
  | { readonly type: "TOOL_CALL_END"; readonly toolCallId: string }
  | {
      readonly type: "TOOL_CALL_RESULT";
      readonly messageId: string;
      readonly toolCallId: string;
      readonly content: string;
      readonly role: "tool";
    }
  | {
      readonly type: "RUN_FINISHED";
      readonly threadId: string;
      readonly runId: string;
      readonly usage: readonly Usage[];
    }
  | { readonly type: "RUN_ERROR"; readonly message: string; readonly code?: string };

export interface AgUiMapperState {
  readonly textMessageId: string | undefined;
  readonly reasoningMessageId: string | undefined;
  readonly openTools: readonly string[];
}

export interface AgUiMapping {
  readonly state: AgUiMapperState;
  readonly events: readonly AgUiEvent[];
}

export const emptyAgUiState = (): AgUiMapperState => ({
  textMessageId: undefined,
  reasoningMessageId: undefined,
  openTools: [],
});

export const startRun = (threadId: string, runId: string): AgUiEvent => ({
  type: "RUN_STARTED",
  threadId,
  runId,
});

export const errorRun = (message: string, code?: string): AgUiEvent => ({
  type: "RUN_ERROR",
  message,
  code,
});

export const finishRun = (
  threadId: string,
  runId: string,
  usage: Usage | undefined,
): AgUiEvent => ({
  type: "RUN_FINISHED",
  threadId,
  runId,
  usage: usage === undefined ? [] : [usage],
});

const mapTextChunk = (
  state: AgUiMapperState,
  messageId: string | undefined,
  delta: string,
): AgUiMapping => {
  const id = messageId ?? state.textMessageId ?? "assistant";
  const events: AgUiEvent[] = [];
  if (state.textMessageId !== id) {
    if (state.textMessageId !== undefined) {
      events.push({ type: "TEXT_MESSAGE_END", messageId: state.textMessageId });
    }
    events.push({ type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" });
  }
  events.push({ type: "TEXT_MESSAGE_CONTENT", messageId: id, delta });
  return { state: { ...state, textMessageId: id }, events };
};

const mapThoughtChunk = (
  state: AgUiMapperState,
  messageId: string | undefined,
  delta: string,
): AgUiMapping => {
  const id = messageId ?? state.reasoningMessageId ?? "reasoning";
  const events: AgUiEvent[] = [];
  if (state.reasoningMessageId !== id) {
    if (state.reasoningMessageId !== undefined) {
      events.push({ type: "REASONING_MESSAGE_END", messageId: state.reasoningMessageId });
    }
    events.push({ type: "REASONING_MESSAGE_START", messageId: id, role: "reasoning" });
  }
  events.push({ type: "REASONING_MESSAGE_CONTENT", messageId: id, delta });
  return { state: { ...state, reasoningMessageId: id }, events };
};

const mapToolCall = (
  state: AgUiMapperState,
  toolCallId: string,
  toolCallName: string,
  rawInput: unknown,
): AgUiMapping => {
  const alreadyOpen = state.openTools.includes(toolCallId);
  const events: AgUiEvent[] = [];
  if (!alreadyOpen) {
    events.push({
      type: "TOOL_CALL_START",
      toolCallId,
      toolCallName,
      parentMessageId: state.textMessageId,
    });
  }
  events.push({ type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify(rawInput ?? {}) });
  const openTools = alreadyOpen ? state.openTools : [...state.openTools, toolCallId];
  return { state: { ...state, openTools }, events };
};

const mapToolCallUpdate = (
  state: AgUiMapperState,
  toolCallId: string,
  status: string | undefined,
  rawOutput: unknown,
): AgUiMapping => {
  const closed = status === "completed" || status === "failed";
  if (!closed) return { state, events: [] };
  const events: AgUiEvent[] = [];
  if (state.openTools.includes(toolCallId)) {
    events.push({ type: "TOOL_CALL_END", toolCallId });
    events.push({
      type: "TOOL_CALL_RESULT",
      messageId: `tool-${toolCallId}`,
      toolCallId,
      content: rawOutput === undefined ? "" : JSON.stringify(rawOutput),
      role: "tool",
    });
  }
  return {
    state: { ...state, openTools: state.openTools.filter((id) => id !== toolCallId) },
    events,
  };
};

export const mapSessionUpdate = (state: AgUiMapperState, update: SessionUpdate): AgUiMapping => {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return mapTextChunk(state, update.messageId, update.content.text);
    case "agent_thought_chunk":
      return mapThoughtChunk(state, update.messageId, update.content.text);
    case "tool_call":
      return mapToolCall(state, update.toolCallId, update.name ?? update.title, update.rawInput);
    case "tool_call_update":
      return mapToolCallUpdate(state, update.toolCallId, update.status, update.rawOutput);
    default:
      return { state, events: [] };
  }
};

export const finishTurn = (state: AgUiMapperState): AgUiMapping => {
  const events: AgUiEvent[] = [];
  if (state.textMessageId !== undefined) {
    events.push({ type: "TEXT_MESSAGE_END", messageId: state.textMessageId });
  }
  if (state.reasoningMessageId !== undefined) {
    events.push({ type: "REASONING_MESSAGE_END", messageId: state.reasoningMessageId });
  }
  for (const toolCallId of state.openTools) {
    events.push({ type: "TOOL_CALL_END", toolCallId });
  }
  return { state: emptyAgUiState(), events };
};
