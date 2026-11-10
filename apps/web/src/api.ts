import type {
  ChatMessage,
  PlanEntry,
  QueueEntry,
  TaskStatus,
  TaskSummary,
  Usage,
} from "@grok-build-web/task-model";
import type { UIMessage } from "@tanstack/ai-react";

export interface TaskDetail extends TaskSummary {
  readonly messages: readonly ChatMessage[];
  readonly plan: readonly PlanEntry[];
  readonly availableCommands: readonly unknown[];
  readonly configOptions: readonly unknown[];
  readonly queue: readonly QueueEntry[];
}

export interface Health {
  readonly ok: boolean;
  readonly acp: {
    readonly connected: boolean;
    readonly url: string;
    readonly lastError?: string;
  };
}

export interface Settings {
  readonly url: string;
  readonly hasSecret: boolean;
  readonly defaultCwd: string;
  readonly defaultModel?: string;
  readonly readOnly: boolean;
}

export interface ModelInfo {
  readonly modelId: string;
  readonly name?: string;
}

export interface AgentInfo {
  readonly connected: boolean;
  readonly models: {
    readonly currentModelId?: string;
    readonly availableModels: readonly ModelInfo[];
  };
  readonly availableCommands: readonly unknown[];
  readonly capabilities: Record<string, unknown>;
}

export interface CreateTaskBody {
  readonly cwd: string;
  readonly prompt?: string;
  readonly model?: string;
  readonly yolo: boolean;
}

export interface PermissionDecision {
  readonly optionId?: string;
  readonly decision?: "cancel";
}

const parseJson = async <A>(response: Response): Promise<A> => {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed with ${response.status}`);
  }
  return (await response.json()) as A;
};

const get = <A>(path: string): Promise<A> => fetch(path).then((response) => parseJson<A>(response));

const post = <A>(path: string, body: unknown): Promise<A> =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((response) => parseJson<A>(response));

const put = <A>(path: string, body: unknown): Promise<A> =>
  fetch(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((response) => parseJson<A>(response));

export const fetchHealth = (): Promise<Health> => get<Health>("/api/health");
export const fetchSettings = (): Promise<Settings> => get<Settings>("/api/settings");
export const fetchAgent = (): Promise<AgentInfo> => get<AgentInfo>("/api/agent");
export const fetchTasks = (): Promise<readonly TaskSummary[]> =>
  get<{ tasks: readonly TaskSummary[] }>("/api/tasks").then((body) => body.tasks);
export const fetchTask = (id: string): Promise<TaskDetail> =>
  get<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`);
export const createTask = (body: CreateTaskBody): Promise<TaskDetail> =>
  post<TaskDetail>("/api/tasks", body);
export const promptTask = (id: string, text: string): Promise<unknown> =>
  post(`/api/tasks/${encodeURIComponent(id)}/prompt`, { text });
export const cancelTask = (id: string): Promise<unknown> =>
  post(`/api/tasks/${encodeURIComponent(id)}/cancel`, {});
export const closeTask = (id: string): Promise<unknown> =>
  post(`/api/tasks/${encodeURIComponent(id)}/close`, {});
export const respondPermission = (id: string, body: PermissionDecision): Promise<unknown> =>
  post(`/api/tasks/${encodeURIComponent(id)}/permission`, body);
export const saveSettings = (body: {
  readonly url?: string;
  readonly secret?: string;
  readonly defaultCwd?: string;
  readonly defaultModel?: string;
}): Promise<Settings> => put<Settings>("/api/settings", body);

export const basename = (path: string): string => {
  const parts = path.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
};

export const relativeTime = (timestamp: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

export const taskTitle = (task: { readonly title: string }): string =>
  task.title === "" ? "Untitled task" : task.title;

export const usageLine = (usage: Usage): string => {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`${usage.inputTokens} in`);
  if (usage.outputTokens !== undefined) parts.push(`${usage.outputTokens} out`);
  if (usage.totalTokens !== undefined) parts.push(`${usage.totalTokens} total`);
  return parts.join(" · ");
};

export const statusLabel = (status: TaskStatus): string => {
  switch (status) {
    case "starting":
      return "Starting";
    case "idle":
      return "Idle";
    case "running":
      return "Running";
    case "awaiting_permission":
      return "Awaiting permission";
    case "error":
      return "Error";
    case "closed":
      return "Closed";
  }
};

export const toInitialMessages = (detail: TaskDetail): UIMessage[] =>
  detail.messages.map((message) => ({
    id: message.id,
    role: message.role,
    parts: message.parts.map((part) => {
      if (part.type === "text") return { type: "text" as const, content: part.text };
      if (part.type === "thinking") return { type: "thinking" as const, content: part.text };
      return {
        type: "tool-call" as const,
        id: part.tool.toolCallId,
        name: part.tool.name,
        arguments:
          part.tool.arguments === "" ? JSON.stringify(part.tool.input ?? {}) : part.tool.arguments,
        state:
          part.tool.status === "completed" ? ("complete" as const) : ("input-complete" as const),
        output: part.tool.output,
      };
    }),
  }));
