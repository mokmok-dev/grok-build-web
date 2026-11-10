import { asArray, asNumber, asRecord, asString } from "./jsonrpc.ts";

export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: string;
}

export interface EnvVariable {
  readonly name: string;
  readonly value: string;
}

export interface TerminalExitStatus {
  readonly exitCode?: number;
  readonly signal?: string;
}

export type ClientRequest =
  | {
      readonly kind: "fs_read";
      readonly sessionId: string;
      readonly path: string;
      readonly line?: number;
      readonly limit?: number;
    }
  | {
      readonly kind: "fs_write";
      readonly sessionId: string;
      readonly path: string;
      readonly content: string;
    }
  | {
      readonly kind: "terminal_create";
      readonly sessionId: string;
      readonly command: string;
      readonly args: readonly string[];
      readonly env: readonly EnvVariable[];
      readonly cwd?: string;
      readonly outputByteLimit?: number;
    }
  | { readonly kind: "terminal_output"; readonly sessionId: string; readonly terminalId: string }
  | {
      readonly kind: "terminal_wait_for_exit";
      readonly sessionId: string;
      readonly terminalId: string;
    }
  | { readonly kind: "terminal_kill"; readonly sessionId: string; readonly terminalId: string }
  | { readonly kind: "terminal_release"; readonly sessionId: string; readonly terminalId: string }
  | {
      readonly kind: "request_permission";
      readonly sessionId: string;
      readonly toolCallId: string;
      readonly title: string;
      readonly options: readonly PermissionOption[];
    };

const parseStringArray = (input: unknown): string[] => {
  const list = asArray(input);
  if (list === undefined) return [];
  const values: string[] = [];
  for (const item of list) {
    const value = asString(item);
    if (value === undefined) continue;
    values.push(value);
  }
  return values;
};

const parseEnv = (input: unknown): EnvVariable[] => {
  const list = asArray(input);
  if (list === undefined) return [];
  const env: EnvVariable[] = [];
  for (const item of list) {
    const record = asRecord(item);
    if (record === undefined) continue;
    const name = asString(record["name"]);
    if (name === undefined) continue;
    env.push({ name, value: asString(record["value"]) ?? "" });
  }
  return env;
};

const parsePermissionOptions = (input: unknown): PermissionOption[] => {
  const list = asArray(input);
  if (list === undefined) return [];
  const options: PermissionOption[] = [];
  for (const item of list) {
    const record = asRecord(item);
    if (record === undefined) continue;
    const optionId = asString(record["optionId"]);
    if (optionId === undefined) continue;
    options.push({
      optionId,
      name: asString(record["name"]) ?? "",
      kind: asString(record["kind"]) ?? "",
    });
  }
  return options;
};

const parseTerminalRequest = (
  kind: "terminal_output" | "terminal_wait_for_exit" | "terminal_kill" | "terminal_release",
  record: Record<string, unknown>,
): ClientRequest | undefined => {
  const sessionId = asString(record["sessionId"]);
  const terminalId = asString(record["terminalId"]);
  if (sessionId === undefined || terminalId === undefined) return undefined;
  return { kind, sessionId, terminalId };
};

type ClientRequestParser = (record: Record<string, unknown>) => ClientRequest | undefined;

const parseFsRead = (record: Record<string, unknown>): ClientRequest | undefined => {
  const sessionId = asString(record["sessionId"]);
  const path = asString(record["path"]);
  if (sessionId === undefined || path === undefined) return undefined;
  return {
    kind: "fs_read",
    sessionId,
    path,
    line: asNumber(record["line"]),
    limit: asNumber(record["limit"]),
  };
};

const parseFsWrite = (record: Record<string, unknown>): ClientRequest | undefined => {
  const sessionId = asString(record["sessionId"]);
  const path = asString(record["path"]);
  const content = asString(record["content"]);
  if (sessionId === undefined || path === undefined || content === undefined) return undefined;
  return { kind: "fs_write", sessionId, path, content };
};

const parseTerminalCreate = (record: Record<string, unknown>): ClientRequest | undefined => {
  const sessionId = asString(record["sessionId"]);
  const command = asString(record["command"]);
  if (sessionId === undefined || command === undefined) return undefined;
  return {
    kind: "terminal_create",
    sessionId,
    command,
    args: parseStringArray(record["args"]),
    env: parseEnv(record["env"]),
    cwd: asString(record["cwd"]),
    outputByteLimit: asNumber(record["outputByteLimit"]),
  };
};

const parsePermissionRequest = (record: Record<string, unknown>): ClientRequest | undefined => {
  const sessionId = asString(record["sessionId"]);
  const toolCall = asRecord(record["toolCall"]);
  if (sessionId === undefined || toolCall === undefined) return undefined;
  const toolCallId = asString(toolCall["toolCallId"]);
  if (toolCallId === undefined) return undefined;
  return {
    kind: "request_permission",
    sessionId,
    toolCallId,
    title: asString(toolCall["title"]) ?? "",
    options: parsePermissionOptions(record["options"]),
  };
};

const clientRequestParsers = new Map<string, ClientRequestParser>([
  ["fs/read_text_file", parseFsRead],
  ["fs/write_text_file", parseFsWrite],
  ["terminal/create", parseTerminalCreate],
  ["terminal/output", (record) => parseTerminalRequest("terminal_output", record)],
  ["terminal/wait_for_exit", (record) => parseTerminalRequest("terminal_wait_for_exit", record)],
  ["terminal/kill", (record) => parseTerminalRequest("terminal_kill", record)],
  ["terminal/release", (record) => parseTerminalRequest("terminal_release", record)],
  ["session/request_permission", parsePermissionRequest],
]);

export const parseClientRequest = (method: string, params: unknown): ClientRequest | undefined => {
  const record = asRecord(params);
  if (record === undefined) return undefined;
  const parser = clientRequestParsers.get(method);
  return parser === undefined ? undefined : parser(record);
};

export const readFileResponse = (content: string): { content: string } => ({ content });

export const emptyResponse = (): Record<string, never> => ({});

export const terminalOutputResponse = (
  output: string,
  truncated: boolean,
  exitStatus?: TerminalExitStatus,
): { output: string; truncated: boolean; exitStatus?: TerminalExitStatus } => ({
  output,
  truncated,
  exitStatus,
});

export const permissionSelected = (
  optionId: string,
): { outcome: { outcome: "selected"; optionId: string } } => ({
  outcome: { outcome: "selected", optionId },
});

export const permissionCancelled = (): { outcome: { outcome: "cancelled" } } => ({
  outcome: { outcome: "cancelled" },
});
