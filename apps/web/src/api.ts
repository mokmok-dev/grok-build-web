import type {
  ChatMessage,
  TaskDetail,
  TaskStatus,
  TaskSummary,
  Usage,
} from "@grok-build-web/task-model";
import type { UIMessage } from "@tanstack/ai-react";

export type { TaskDetail };

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
  readonly roots: readonly string[];
  readonly defaultModel?: string;
  readonly readOnly: boolean;
  readonly configFile: string;
  readonly configFileExists: boolean;
}

export interface ModelInfo {
  readonly modelId: string;
  readonly name?: string;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly root: string;
}

export interface DirectoryListing {
  readonly path: string;
  readonly entries: readonly string[];
  readonly truncated?: true;
}

export interface ProjectInput {
  readonly name?: string;
  readonly root: string;
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
  readonly cwd?: string;
  readonly prompt?: string;
  readonly model?: string;
  readonly yolo: boolean;
}

export interface PermissionDecision {
  readonly requestId: string;
  readonly optionId?: string;
  readonly decision?: "cancel";
}

type Method = "GET" | "POST";

const send = async <A>(method: Method, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Request failed with ${response.status}`);
  }
  return (await response.json()) as A;
};

export const fetchHealth = (): Promise<Health> => send<Health>("GET", "/api/health");
export const fetchSettings = (): Promise<Settings> => send<Settings>("GET", "/api/settings");
export const fetchAgent = (): Promise<AgentInfo> => send<AgentInfo>("GET", "/api/agent");
export const fetchTasks = (): Promise<readonly TaskSummary[]> =>
  send<{ tasks: readonly TaskSummary[] }>("GET", "/api/tasks").then((body) => body.tasks);
export const fetchTask = (id: string): Promise<TaskDetail> =>
  send<TaskDetail>("GET", `/api/tasks/${encodeURIComponent(id)}`);
export const createTask = (body: CreateTaskBody): Promise<TaskDetail> =>
  send<TaskDetail>("POST", "/api/tasks", body);
export const fetchProjects = (): Promise<readonly Project[]> =>
  send<{ projects: readonly Project[] }>("GET", "/api/projects").then((body) => body.projects);
export const createProject = (body: ProjectInput): Promise<Project> =>
  send<Project>("POST", "/api/projects", body);
export const fetchDirs = (path: string | null): Promise<DirectoryListing> =>
  send<DirectoryListing>(
    "GET",
    path === null ? "/api/fs/dirs" : `/api/fs/dirs?path=${encodeURIComponent(path)}`,
  );
export const cancelTask = (id: string): Promise<unknown> =>
  send("POST", `/api/tasks/${encodeURIComponent(id)}/cancel`, {});
export const closeTask = (id: string): Promise<unknown> =>
  send("POST", `/api/tasks/${encodeURIComponent(id)}/close`, {});
export const respondPermission = (id: string, body: PermissionDecision): Promise<unknown> =>
  send("POST", `/api/tasks/${encodeURIComponent(id)}/permission`, body);

export const basename = (path: string): string => {
  const parts = path.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
};

export const isWithinRoot = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

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

export const STATUS_LABELS: Record<TaskStatus, string> = {
  starting: "Starting",
  idle: "Idle",
  running: "Running",
  awaiting_permission: "Awaiting permission",
  error: "Error",
  closed: "Closed",
};

export type Connection = "connected" | "reconnecting" | "disconnected";

export const connectionOf = (health: Health | null): Connection => {
  if (health === null) return "disconnected";
  if (health.acp.connected) return "connected";
  return health.acp.lastError === undefined ? "disconnected" : "reconnecting";
};

export const CONNECTION_LABELS: Record<Connection, string> = {
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
};

export const toInitialMessages = (detail: {
  readonly messages: readonly ChatMessage[];
}): UIMessage[] =>
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
