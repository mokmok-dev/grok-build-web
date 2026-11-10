import { asArray, asNumber, asRecord, asString } from "./jsonrpc.ts";

export interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly reasoningTokens?: number;
}

export interface ModelInfo {
  readonly modelId: string;
  readonly name?: string;
}

export interface ModelState {
  readonly currentModelId?: string;
  readonly availableModels: readonly ModelInfo[];
}

export interface SessionConfigOption {
  readonly id: string;
  readonly name?: string;
}

export interface InitializeResult {
  readonly protocolVersion?: number;
  readonly agentCapabilities: Record<string, unknown>;
  readonly authMethods: readonly unknown[];
  readonly currentWorkingDirectory?: string;
  readonly modelState?: ModelState;
  readonly availableCommands: readonly unknown[];
}

export interface SessionNewResult {
  readonly sessionId: string;
  readonly models?: ModelState;
  readonly configOptions: readonly SessionConfigOption[];
}

export interface PromptResult {
  readonly stopReason?: string;
  readonly usage?: Usage;
}

export interface PlanEntry {
  readonly content: string;
  readonly priority: string;
  readonly status: string;
}

export interface QueueEntry {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
}

export interface SessionChange {
  readonly sessionId: string;
  readonly title?: string;
  readonly cwd?: string;
  readonly activity?: string;
  readonly modelId?: string;
}

export type SessionUpdate =
  | {
      readonly sessionUpdate: "agent_message_chunk";
      readonly content: { readonly type: "text"; readonly text: string };
      readonly messageId?: string;
    }
  | {
      readonly sessionUpdate: "agent_thought_chunk";
      readonly content: { readonly type: "text"; readonly text: string };
      readonly messageId?: string;
    }
  | {
      readonly sessionUpdate: "tool_call";
      readonly toolCallId: string;
      readonly title: string;
      readonly name?: string;
      readonly kind?: string;
      readonly status?: string;
      readonly rawInput?: unknown;
    }
  | {
      readonly sessionUpdate: "tool_call_update";
      readonly toolCallId: string;
      readonly status?: string;
      readonly title?: string;
      readonly rawOutput?: unknown;
    }
  | { readonly sessionUpdate: "plan"; readonly entries: readonly PlanEntry[] }
  | { readonly sessionUpdate: "session_info_update"; readonly title?: string }
  | {
      readonly sessionUpdate: "available_commands_update";
      readonly availableCommands: readonly unknown[];
    }
  | { readonly sessionUpdate: "config_option_update"; readonly configOptions: readonly unknown[] }
  | {
      readonly sessionUpdate: "usage_update";
      readonly usage?: Usage;
      readonly used?: number;
      readonly size?: number;
    };

export type SessionNotificationUpdate =
  | {
      readonly sessionUpdate: "turn_completed";
      readonly promptId?: string;
      readonly stopReason?: string;
      readonly usage?: Usage;
    }
  | { readonly sessionUpdate: "response_completed"; readonly usage?: Usage }
  | {
      readonly sessionUpdate: "tool_call_delta_chunk";
      readonly toolCallId: string;
      readonly name?: string;
      readonly argumentsDelta?: string;
    }
  | {
      readonly sessionUpdate: "pending_interaction";
      readonly toolCallId: string;
      readonly kind: string;
    }
  | { readonly sessionUpdate: "interaction_resolved"; readonly toolCallId: string }
  | {
      readonly sessionUpdate: "session_summary_generated";
      readonly sessionSummary?: string;
    };

export type ServerNotification =
  | { readonly kind: "session_update"; readonly sessionId: string; readonly update: SessionUpdate }
  | {
      readonly kind: "session_notification";
      readonly sessionId: string;
      readonly update: SessionNotificationUpdate;
    }
  | {
      readonly kind: "queue_changed";
      readonly sessionId: string;
      readonly entries: readonly QueueEntry[];
      readonly runningPromptId?: string;
    }
  | {
      readonly kind: "sessions_changed";
      readonly upserted: readonly SessionChange[];
      readonly removed: readonly unknown[];
    }
  | {
      readonly kind: "prompt_complete";
      readonly sessionId: string;
      readonly promptId?: string;
      readonly stopReason?: string;
    }
  | {
      readonly kind: "models_update";
      readonly currentModelId?: string;
      readonly availableModels: readonly ModelInfo[];
    };

export const parseUsage = (input: unknown): Usage | undefined => {
  const record = asRecord(input);
  if (record === undefined) return undefined;
  return {
    inputTokens: asNumber(record["inputTokens"]) ?? asNumber(record["input_tokens"]),
    outputTokens: asNumber(record["outputTokens"]) ?? asNumber(record["output_tokens"]),
    totalTokens: asNumber(record["totalTokens"]) ?? asNumber(record["total_tokens"]),
    reasoningTokens: asNumber(record["reasoningTokens"]) ?? asNumber(record["reasoning_tokens"]),
  };
};

const parseModelInfos = (input: unknown): ModelInfo[] => {
  const list = asArray(input);
  if (list === undefined) return [];
  const models: ModelInfo[] = [];
  for (const item of list) {
    const record = asRecord(item);
    if (record === undefined) continue;
    models.push({
      modelId: asString(record["modelId"]) ?? asString(record["id"]) ?? "",
      name: asString(record["name"]),
    });
  }
  return models;
};

export const parseModelState = (input: unknown): ModelState | undefined => {
  const record = asRecord(input);
  if (record === undefined) return undefined;
  return {
    currentModelId: asString(record["currentModelId"]),
    availableModels: parseModelInfos(record["availableModels"]),
  };
};

const parseConfigOptions = (input: unknown): SessionConfigOption[] => {
  const list = asArray(input);
  if (list === undefined) return [];
  const options: SessionConfigOption[] = [];
  for (const item of list) {
    const record = asRecord(item);
    if (record === undefined) continue;
    options.push({ id: asString(record["id"]) ?? "", name: asString(record["name"]) });
  }
  return options;
};

export const parseInitializeResult = (input: unknown): InitializeResult => {
  const record = asRecord(input) ?? {};
  const meta = asRecord(record["_meta"]) ?? {};
  return {
    protocolVersion: asNumber(record["protocolVersion"]),
    agentCapabilities: asRecord(record["agentCapabilities"]) ?? {},
    authMethods: asArray(record["authMethods"]) ?? [],
    currentWorkingDirectory: asString(meta["currentWorkingDirectory"]),
    modelState: parseModelState(meta["modelState"]),
    availableCommands: asArray(meta["availableCommands"]) ?? [],
  };
};

export const parseSessionNewResult = (input: unknown): SessionNewResult | undefined => {
  const record = asRecord(input);
  if (record === undefined) return undefined;
  const sessionId = asString(record["sessionId"]);
  if (sessionId === undefined) return undefined;
  return {
    sessionId,
    models: parseModelState(record["models"]),
    configOptions: parseConfigOptions(record["configOptions"]),
  };
};

export const parsePromptResult = (input: unknown): PromptResult => {
  const record = asRecord(input) ?? {};
  const meta = asRecord(record["_meta"]) ?? {};
  return {
    stopReason: asString(record["stopReason"]),
    usage: parseUsage(record["usage"]) ?? parseUsage(meta["usage"]),
  };
};

const parseTextChunk = (
  record: Record<string, unknown>,
  tag: "agent_message_chunk" | "agent_thought_chunk",
): SessionUpdate | undefined => {
  const content = asRecord(record["content"]);
  if (content === undefined) return undefined;
  const text = asString(content["text"]);
  if (text === undefined) return undefined;
  return {
    sessionUpdate: tag,
    content: { type: "text", text },
    messageId: asString(record["messageId"]),
  };
};

const parsePlanEntries = (input: unknown): PlanEntry[] | undefined => {
  const list = asArray(input);
  if (list === undefined) return undefined;
  const entries: PlanEntry[] = [];
  for (const item of list) {
    const record = asRecord(item);
    if (record === undefined) continue;
    entries.push({
      content: asString(record["content"]) ?? "",
      priority: asString(record["priority"]) ?? "",
      status: asString(record["status"]) ?? "",
    });
  }
  return entries;
};

type UpdateParser = (record: Record<string, unknown>) => SessionUpdate | undefined;

const parseToolCall = (record: Record<string, unknown>): SessionUpdate | undefined => {
  const toolCallId = asString(record["toolCallId"]);
  if (toolCallId === undefined) return undefined;
  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title: asString(record["title"]) ?? "",
    name: asString(record["name"]),
    kind: asString(record["kind"]),
    status: asString(record["status"]),
    rawInput: record["rawInput"],
  };
};

const parseToolCallUpdate = (record: Record<string, unknown>): SessionUpdate | undefined => {
  const toolCallId = asString(record["toolCallId"]);
  if (toolCallId === undefined) return undefined;
  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: asString(record["status"]),
    title: asString(record["title"]),
    rawOutput: record["rawOutput"],
  };
};

const parsePlan = (record: Record<string, unknown>): SessionUpdate | undefined => {
  const entries = parsePlanEntries(record["entries"]);
  if (entries === undefined) return undefined;
  return { sessionUpdate: "plan", entries };
};

const sessionUpdateParsers = new Map<string, UpdateParser>([
  ["agent_message_chunk", (record) => parseTextChunk(record, "agent_message_chunk")],
  ["agent_thought_chunk", (record) => parseTextChunk(record, "agent_thought_chunk")],
  ["tool_call", parseToolCall],
  ["tool_call_update", parseToolCallUpdate],
  ["plan", parsePlan],
  [
    "session_info_update",
    (record) => ({ sessionUpdate: "session_info_update", title: asString(record["title"]) }),
  ],
  [
    "available_commands_update",
    (record) => ({
      sessionUpdate: "available_commands_update",
      availableCommands: asArray(record["availableCommands"]) ?? [],
    }),
  ],
  [
    "config_option_update",
    (record) => ({
      sessionUpdate: "config_option_update",
      configOptions: asArray(record["configOptions"]) ?? [],
    }),
  ],
  [
    "usage_update",
    (record) => ({
      sessionUpdate: "usage_update",
      usage: parseUsage(record["usage"]),
      used: asNumber(record["used"]),
      size: asNumber(record["size"]),
    }),
  ],
]);

export const parseSessionUpdate = (input: unknown): SessionUpdate | undefined => {
  const record = asRecord(input);
  if (record === undefined) return undefined;
  const parser = sessionUpdateParsers.get(String(record["sessionUpdate"]));
  return parser === undefined ? undefined : parser(record);
};

type NotificationUpdateParser = (
  record: Record<string, unknown>,
) => SessionNotificationUpdate | undefined;

const parseToolDelta = (record: Record<string, unknown>): SessionNotificationUpdate | undefined => {
  const toolCallId = asString(record["tool_call_id"]);
  if (toolCallId === undefined) return undefined;
  return {
    sessionUpdate: "tool_call_delta_chunk",
    toolCallId,
    name: asString(record["name"]),
    argumentsDelta: asString(record["arguments_delta"]),
  };
};

const parsePendingInteraction = (
  record: Record<string, unknown>,
): SessionNotificationUpdate | undefined => {
  const toolCallId = asString(record["tool_call_id"]);
  if (toolCallId === undefined) return undefined;
  return {
    sessionUpdate: "pending_interaction",
    toolCallId,
    kind: asString(record["kind"]) ?? "",
  };
};

const parseInteractionResolved = (
  record: Record<string, unknown>,
): SessionNotificationUpdate | undefined => {
  const toolCallId = asString(record["tool_call_id"]);
  if (toolCallId === undefined) return undefined;
  return { sessionUpdate: "interaction_resolved", toolCallId };
};

const sessionNotificationParsers = new Map<string, NotificationUpdateParser>([
  [
    "turn_completed",
    (record) => ({
      sessionUpdate: "turn_completed",
      promptId: asString(record["prompt_id"]),
      stopReason: asString(record["stop_reason"]),
      usage: parseUsage(record["usage"]),
    }),
  ],
  [
    "response_completed",
    (record) => ({ sessionUpdate: "response_completed", usage: parseUsage(record["usage"]) }),
  ],
  ["tool_call_delta_chunk", parseToolDelta],
  ["pending_interaction", parsePendingInteraction],
  ["interaction_resolved", parseInteractionResolved],
  [
    "session_summary_generated",
    (record) => ({
      sessionUpdate: "session_summary_generated",
      sessionSummary: asString(record["session_summary"]),
    }),
  ],
]);

const parseSessionNotificationUpdate = (input: unknown): SessionNotificationUpdate | undefined => {
  const record = asRecord(input);
  if (record === undefined) return undefined;
  const parser = sessionNotificationParsers.get(String(record["sessionUpdate"]));
  return parser === undefined ? undefined : parser(record);
};

const parseSessionUpdateNotification = (params: unknown): ServerNotification | undefined => {
  const record = asRecord(params);
  if (record === undefined) return undefined;
  const sessionId = asString(record["sessionId"]);
  if (sessionId === undefined) return undefined;
  const update = parseSessionUpdate(record["update"]);
  if (update === undefined) return undefined;
  return { kind: "session_update", sessionId, update };
};

const parseSessionNotification = (params: unknown): ServerNotification | undefined => {
  const record = asRecord(params);
  if (record === undefined) return undefined;
  const sessionId = asString(record["sessionId"]);
  if (sessionId === undefined) return undefined;
  const update = parseSessionNotificationUpdate(record["update"]);
  if (update === undefined) return undefined;
  return { kind: "session_notification", sessionId, update };
};

const parseQueueEntries = (input: unknown): QueueEntry[] => {
  const list = asArray(input);
  if (list === undefined) return [];
  const entries: QueueEntry[] = [];
  for (const item of list) {
    const record = asRecord(item);
    if (record === undefined) continue;
    entries.push({
      id: asString(record["id"]) ?? "",
      kind: asString(record["kind"]) ?? "",
      text: asString(record["text"]) ?? "",
    });
  }
  return entries;
};

const parseQueueChanged = (params: unknown): ServerNotification | undefined => {
  const record = asRecord(params);
  if (record === undefined) return undefined;
  const sessionId = asString(record["sessionId"]);
  if (sessionId === undefined) return undefined;
  return {
    kind: "queue_changed",
    sessionId,
    entries: parseQueueEntries(record["entries"]),
    runningPromptId: asString(record["runningPromptId"]),
  };
};

const parseSessionChanges = (input: unknown): SessionChange[] => {
  const list = asArray(input);
  if (list === undefined) return [];
  const changes: SessionChange[] = [];
  for (const item of list) {
    const record = asRecord(item);
    if (record === undefined) continue;
    const sessionId = asString(record["sessionId"]);
    if (sessionId === undefined) continue;
    changes.push({
      sessionId,
      title: asString(record["title"]),
      cwd: asString(record["cwd"]),
      activity: asString(record["activity"]),
      modelId: asString(record["modelId"]),
    });
  }
  return changes;
};

const parseSessionsChanged = (params: unknown): ServerNotification | undefined => {
  const record = asRecord(params);
  if (record === undefined) return undefined;
  return {
    kind: "sessions_changed",
    upserted: parseSessionChanges(record["upserted"]),
    removed: asArray(record["removed"]) ?? [],
  };
};

const parsePromptComplete = (params: unknown): ServerNotification | undefined => {
  const record = asRecord(params);
  if (record === undefined) return undefined;
  const sessionId = asString(record["sessionId"]);
  if (sessionId === undefined) return undefined;
  return {
    kind: "prompt_complete",
    sessionId,
    promptId: asString(record["promptId"]),
    stopReason: asString(record["stopReason"]),
  };
};

const parseModelsUpdate = (params: unknown): ServerNotification | undefined => {
  const record = asRecord(params);
  if (record === undefined) return undefined;
  return {
    kind: "models_update",
    currentModelId: asString(record["currentModelId"]),
    availableModels: parseModelInfos(record["availableModels"]),
  };
};

type NotificationParser = (params: unknown) => ServerNotification | undefined;

const notificationParsers = new Map<string, NotificationParser>([
  ["session/update", parseSessionUpdateNotification],
  ["x.ai/session_notification", parseSessionNotification],
  ["x.ai/queue/changed", parseQueueChanged],
  ["x.ai/sessions/changed", parseSessionsChanged],
  ["x.ai/session/prompt_complete", parsePromptComplete],
  ["x.ai/models/update", parseModelsUpdate],
]);

export const parseServerNotification = (
  method: string,
  params: unknown,
): ServerNotification | undefined => {
  const parser = notificationParsers.get(normalizeMethod(method));
  return parser === undefined ? undefined : parser(params);
};

export const normalizeMethod = (method: string): string =>
  method.startsWith("_x.ai/") ? method.slice(1) : method;
