import type {
  PermissionOption,
  PlanEntry,
  QueueEntry,
  ServerNotification,
  SessionChange,
  SessionUpdate,
  SessionNotificationUpdate,
  Usage,
} from "@grok-build-web/acp-protocol";

export type TaskStatus =
  | "starting"
  | "idle"
  | "running"
  | "awaiting_permission"
  | "error"
  | "closed";

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolCall {
  readonly toolCallId: string;
  readonly name: string;
  readonly title: string;
  readonly kind?: string;
  readonly status: ToolCallStatus;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly arguments: string;
}

export type MessagePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "tool"; readonly tool: ToolCall };

export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly createdAt: number;
  readonly parts: readonly MessagePart[];
}

export interface PendingPermission {
  readonly requestId: string;
  readonly toolCallId: string;
  readonly title: string;
  readonly options: readonly PermissionOption[];
}

export interface Task {
  readonly id: string;
  readonly cwd: string;
  readonly title: string;
  readonly model?: string;
  readonly status: TaskStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messages: readonly ChatMessage[];
  readonly plan: readonly PlanEntry[];
  readonly usage: Usage;
  readonly lastError?: string;
  readonly pendingPermission?: PendingPermission;
  readonly availableCommands: readonly unknown[];
  readonly configOptions: readonly unknown[];
  readonly queue: readonly QueueEntry[];
  readonly runningPromptId?: string;
  readonly yolo: boolean;
}

export interface TaskSummary {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly model?: string;
  readonly status: TaskStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
  readonly pendingPermission?: PendingPermission;
  readonly usage: Usage;
  readonly lastError?: string;
  readonly yolo: boolean;
}

export interface CreateTaskInput {
  readonly id: string;
  readonly cwd: string;
  readonly title?: string;
  readonly model?: string;
  readonly yolo?: boolean;
  readonly now: number;
}

export const createTask = (input: CreateTaskInput): Task => ({
  id: input.id,
  cwd: input.cwd,
  title: input.title ?? "",
  model: input.model,
  status: "starting",
  createdAt: input.now,
  updatedAt: input.now,
  messages: [],
  plan: [],
  usage: {},
  lastError: undefined,
  pendingPermission: undefined,
  availableCommands: [],
  configOptions: [],
  queue: [],
  runningPromptId: undefined,
  yolo: input.yolo ?? false,
});

const touched = (task: Task, now: number, patch: Partial<Task>): Task => ({
  ...task,
  ...patch,
  updatedAt: now,
});

export const markReady = (task: Task, now: number): Task => touched(task, now, { status: "idle" });

export const markClosed = (task: Task, now: number): Task =>
  touched(task, now, { status: "closed" });

export const markError = (task: Task, message: string, now: number): Task =>
  touched(task, now, { status: "error", lastError: message, runningPromptId: undefined });

export const startPrompt = (task: Task, promptId: string, text: string, now: number): Task =>
  touched(task, now, {
    status: "running",
    runningPromptId: promptId,
    messages: [
      ...task.messages,
      {
        id: `user-${task.messages.length}`,
        role: "user",
        createdAt: now,
        parts: [{ type: "text", text }],
      },
    ],
  });

export const finishPrompt = (task: Task, now: number): Task =>
  touched(task, now, {
    runningPromptId: undefined,
    status: task.pendingPermission === undefined ? "idle" : "awaiting_permission",
  });

export const setPendingPermission = (
  task: Task,
  permission: PendingPermission,
  now: number,
): Task =>
  touched(task, now, {
    status: "awaiting_permission",
    pendingPermission: permission,
  });

export const resolvePermission = (task: Task, now: number): Task =>
  touched(task, now, {
    pendingPermission: undefined,
    status: task.runningPromptId === undefined ? "idle" : "running",
  });

export const mergeUsage = (base: Usage, patch: Usage | undefined): Usage => {
  if (patch === undefined) return base;
  return {
    inputTokens: patch.inputTokens ?? base.inputTokens,
    outputTokens: patch.outputTokens ?? base.outputTokens,
    totalTokens: patch.totalTokens ?? base.totalTokens,
    reasoningTokens: patch.reasoningTokens ?? base.reasoningTokens,
  };
};

const toolStatus = (input: string | undefined, fallback: ToolCallStatus): ToolCallStatus => {
  if (input === "pending") return "pending";
  if (input === "in_progress") return "in_progress";
  if (input === "completed") return "completed";
  if (input === "failed") return "failed";
  return fallback;
};

const appendText = (message: ChatMessage, type: "text" | "thinking", text: string): ChatMessage => {
  const last = message.parts[message.parts.length - 1];
  if (last !== undefined && last.type === type) {
    const merged = { type, text: last.text + text };
    return { ...message, parts: [...message.parts.slice(0, -1), merged] };
  }
  return { ...message, parts: [...message.parts, { type, text }] };
};

const targetIndex = (task: Task, messageId: string | undefined): number | undefined => {
  if (messageId !== undefined) {
    const index = task.messages.findIndex((message) => message.id === messageId);
    return index === -1 ? undefined : index;
  }
  const lastIndex = task.messages.length - 1;
  const last = task.messages[lastIndex];
  return last !== undefined && last.role === "assistant" ? lastIndex : undefined;
};

const withAssistantMessage = (
  task: Task,
  now: number,
  messageId: string | undefined,
  change: (message: ChatMessage) => ChatMessage,
): Task => {
  const index = targetIndex(task, messageId);
  if (index === undefined) {
    const created = change({
      id: messageId ?? `assistant-${task.messages.length}`,
      role: "assistant",
      createdAt: now,
      parts: [],
    });
    return touched(task, now, { messages: [...task.messages, created] });
  }
  const messages = task.messages.map((message, current) =>
    current === index ? change(message) : message,
  );
  return touched(task, now, { messages });
};

const withTool = (
  task: Task,
  now: number,
  toolCallId: string,
  change: (tool: ToolCall | undefined) => ToolCall,
): Task =>
  withAssistantMessage(task, now, undefined, (message) => {
    const exists = message.parts.some(
      (part) => part.type === "tool" && part.tool.toolCallId === toolCallId,
    );
    if (!exists) {
      return { ...message, parts: [...message.parts, { type: "tool", tool: change(undefined) }] };
    }
    const parts = message.parts.map((part) =>
      part.type === "tool" && part.tool.toolCallId === toolCallId
        ? { type: "tool" as const, tool: change(part.tool) }
        : part,
    );
    return { ...message, parts };
  });

const applySessionUpdate = (task: Task, update: SessionUpdate, now: number): Task => {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return withAssistantMessage(task, now, update.messageId, (message) =>
        appendText(message, "text", update.content.text),
      );
    case "agent_thought_chunk":
      return withAssistantMessage(task, now, update.messageId, (message) =>
        appendText(message, "thinking", update.content.text),
      );
    case "tool_call":
      return withTool(task, now, update.toolCallId, (existing) => ({
        toolCallId: update.toolCallId,
        name: update.name ?? existing?.name ?? "",
        title: update.title === "" ? (existing?.title ?? "") : update.title,
        kind: update.kind ?? existing?.kind,
        status: toolStatus(update.status, existing?.status ?? "pending"),
        input: update.rawInput ?? existing?.input,
        output: existing?.output,
        arguments: existing?.arguments ?? "",
      }));
    case "tool_call_update":
      return withTool(task, now, update.toolCallId, (existing) => ({
        toolCallId: update.toolCallId,
        name: existing?.name ?? "",
        title: update.title ?? existing?.title ?? "",
        kind: existing?.kind,
        status: toolStatus(update.status, existing?.status ?? "pending"),
        input: existing?.input,
        output: update.rawOutput ?? existing?.output,
        arguments: existing?.arguments ?? "",
      }));
    case "plan":
      return touched(task, now, { plan: update.entries });
    case "session_info_update":
      return update.title === undefined ? task : touched(task, now, { title: update.title });
    case "available_commands_update":
      return touched(task, now, { availableCommands: update.availableCommands });
    case "config_option_update":
      return touched(task, now, { configOptions: update.configOptions });
    case "usage_update":
      return update.usage === undefined
        ? task
        : touched(task, now, { usage: mergeUsage(task.usage, update.usage) });
  }
};

const applySessionNotification = (
  task: Task,
  update: SessionNotificationUpdate,
  now: number,
): Task => {
  switch (update.sessionUpdate) {
    case "turn_completed":
      return touched(task, now, {
        status: "idle",
        runningPromptId: undefined,
        usage: mergeUsage(task.usage, update.usage),
      });
    case "response_completed":
      return update.usage === undefined
        ? task
        : touched(task, now, { usage: mergeUsage(task.usage, update.usage) });
    case "tool_call_delta_chunk":
      return withTool(task, now, update.toolCallId, (existing) => ({
        toolCallId: update.toolCallId,
        name: update.name ?? existing?.name ?? "",
        title: existing?.title ?? "",
        kind: existing?.kind,
        status: existing?.status ?? "pending",
        input: existing?.input,
        output: existing?.output,
        arguments: (existing?.arguments ?? "") + (update.argumentsDelta ?? ""),
      }));
    case "pending_interaction":
      return update.kind === "permission"
        ? touched(task, now, { status: "awaiting_permission" })
        : task;
    case "interaction_resolved":
      return touched(task, now, {
        status: task.runningPromptId === undefined ? "idle" : "running",
      });
    case "session_summary_generated":
      return task;
  }
};

const applyQueueChanged = (
  task: Task,
  notification: Extract<ServerNotification, { kind: "queue_changed" }>,
  now: number,
): Task =>
  touched(task, now, {
    queue: notification.entries,
    runningPromptId: notification.runningPromptId,
    status: notification.runningPromptId === undefined ? "idle" : "running",
  });

export const applyNotification = (
  task: Task,
  notification: ServerNotification,
  now: number,
): Task => {
  switch (notification.kind) {
    case "session_update":
      return applySessionUpdate(task, notification.update, now);
    case "session_notification":
      return applySessionNotification(task, notification.update, now);
    case "queue_changed":
      return applyQueueChanged(task, notification, now);
    case "prompt_complete":
      return touched(task, now, { status: "idle", runningPromptId: undefined });
    default:
      return task;
  }
};

export const applySessionChange = (task: Task, change: SessionChange, now: number): Task => {
  if (change.sessionId !== task.id) return task;
  const patch: {
    title?: string;
    model?: string;
    status?: TaskStatus;
    updatedAt: number;
  } = { updatedAt: now };
  if (change.title !== undefined) patch.title = change.title;
  if (change.modelId !== undefined) patch.model = change.modelId;
  if (change.activity === "working") patch.status = "running";
  if (change.activity === "idle") patch.status = "idle";
  return { ...task, ...patch };
};

export const toSummary = (task: Task): TaskSummary => ({
  id: task.id,
  title: task.title,
  cwd: task.cwd,
  model: task.model,
  status: task.status,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  messageCount: task.messages.length,
  pendingPermission: task.pendingPermission,
  usage: task.usage,
  lastError: task.lastError,
  yolo: task.yolo,
});

export type TaskDetail = TaskSummary &
  Pick<Task, "messages" | "plan" | "availableCommands" | "configOptions" | "queue">;

export const toDetail = (task: Task): TaskDetail => ({
  ...toSummary(task),
  messages: task.messages,
  plan: task.plan,
  availableCommands: task.availableCommands,
  configOptions: task.configOptions,
  queue: task.queue,
});
