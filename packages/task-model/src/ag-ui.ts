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
  readonly runId: string;
  readonly textMessageId: string | undefined;
  readonly reasoningMessageId: string | undefined;
  readonly openTools: readonly string[];
}

export interface AgUiMapping {
  readonly state: AgUiMapperState;
  readonly events: readonly AgUiEvent[];
}

export const emptyAgUiState = (runId: string): AgUiMapperState => ({
  runId,
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

type StreamKind = "text" | "reasoning";

const startEvent = (kind: StreamKind, messageId: string): AgUiEvent =>
  kind === "text"
    ? { type: "TEXT_MESSAGE_START", messageId, role: "assistant" }
    : { type: "REASONING_MESSAGE_START", messageId, role: "reasoning" };

const contentEvent = (kind: StreamKind, messageId: string, delta: string): AgUiEvent =>
  kind === "text"
    ? { type: "TEXT_MESSAGE_CONTENT", messageId, delta }
    : { type: "REASONING_MESSAGE_CONTENT", messageId, delta };

const endEvent = (kind: StreamKind, messageId: string): AgUiEvent =>
  kind === "text"
    ? { type: "TEXT_MESSAGE_END", messageId }
    : { type: "REASONING_MESSAGE_END", messageId };

const mapStreamChunk = (
  state: AgUiMapperState,
  kind: StreamKind,
  messageId: string | undefined,
  delta: string,
): AgUiMapping => {
  const current = kind === "text" ? state.textMessageId : state.reasoningMessageId;
  const id = messageId ?? current ?? `${state.runId}-${kind}`;
  const events: AgUiEvent[] = [];
  if (current !== id) {
    if (current !== undefined) events.push(endEvent(kind, current));
    events.push(startEvent(kind, id));
  }
  events.push(contentEvent(kind, id, delta));
  return {
    state: kind === "text" ? { ...state, textMessageId: id } : { ...state, reasoningMessageId: id },
    events,
  };
};

const mapToolCall = (
  state: AgUiMapperState,
  toolCallId: string,
  toolCallName: string,
  rawInput: unknown,
): AgUiMapping => {
  if (state.openTools.includes(toolCallId)) return { state, events: [] };
  return {
    state: { ...state, openTools: [...state.openTools, toolCallId] },
    events: [
      {
        type: "TOOL_CALL_START",
        toolCallId,
        toolCallName,
        parentMessageId: state.textMessageId,
      },
      { type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify(rawInput ?? {}) },
    ],
  };
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
      messageId: `${state.runId}-tool-${toolCallId}`,
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
      return mapStreamChunk(state, "text", update.messageId, update.content.text);
    case "agent_thought_chunk":
      return mapStreamChunk(state, "reasoning", update.messageId, update.content.text);
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
  return { state: emptyAgUiState(state.runId), events };
};
