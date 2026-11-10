export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const JSON_RPC_VERSION = "2.0";

export const asRecord = (input: unknown): Record<string, unknown> | undefined => {
  if (typeof input !== "object") return undefined;
  if (input === null) return undefined;
  if (Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
};

export const asString = (input: unknown): string | undefined =>
  typeof input === "string" ? input : undefined;

export const asNumber = (input: unknown): number | undefined =>
  typeof input === "number" ? input : undefined;

export const asArray = (input: unknown): unknown[] | undefined =>
  Array.isArray(input) ? input : undefined;

const parseId = (input: unknown): JsonRpcId | undefined => {
  if (input === null) return null;
  if (typeof input === "string") return input;
  if (typeof input === "number") return input;
  return undefined;
};

const parseErrorObject = (input: unknown): JsonRpcErrorObject | undefined => {
  const record = asRecord(input);
  if (record === undefined) return undefined;
  const code = asNumber(record["code"]);
  const message = asString(record["message"]);
  if (code === undefined || message === undefined) return undefined;
  return { code, message, data: record["data"] };
};

export const parseJsonRpcValue = (input: unknown): JsonRpcMessage | undefined => {
  const record = asRecord(input);
  if (record === undefined) return undefined;
  if (record["jsonrpc"] !== JSON_RPC_VERSION) return undefined;
  const method = asString(record["method"]);
  if (method !== undefined) {
    const params = record["params"];
    if (!("id" in record)) return { jsonrpc: JSON_RPC_VERSION, method, params };
    const id = parseId(record["id"]);
    if (id === undefined) return undefined;
    return { jsonrpc: JSON_RPC_VERSION, id, method, params };
  }
  const id = parseId(record["id"]);
  if (id === undefined) return undefined;
  const error = parseErrorObject(record["error"]);
  if (error !== undefined) return { jsonrpc: JSON_RPC_VERSION, id, error };
  if (!("result" in record)) return undefined;
  return { jsonrpc: JSON_RPC_VERSION, id, result: record["result"] };
};

export const parseJsonRpcMessage = (raw: string): JsonRpcMessage | undefined => {
  let value: unknown;
  // Stryker disable all: an emptied catch still leaves `value` undefined, so no mutant there can change behaviour
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  // Stryker restore all
  return parseJsonRpcValue(value);
};

export const isResponse = (message: JsonRpcMessage): message is JsonRpcResponse =>
  "id" in message && !("method" in message);

export const encodeRequest = (id: JsonRpcId, method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, method, params });

export const encodeNotification = (method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: JSON_RPC_VERSION, method, params });

export const encodeResult = (id: JsonRpcId, result: unknown): string =>
  JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, result });

export const encodeError = (id: JsonRpcId, code: number, message: string): string =>
  JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, error: { code, message } });
