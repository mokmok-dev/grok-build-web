import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isUsableRoot } from "./paths.ts";

export interface ServerConfig {
  readonly acpUrl: string;
  readonly acpSecret?: string;
  readonly port: number;
  readonly host: string;
  readonly serverCwd: string;
  readonly allowedRoots: readonly string[];
  readonly defaultCwd: string;
  readonly readOnly: boolean;
  readonly maxTerminals: number;
  readonly terminalOutputLimit: number;
  readonly maxTasks: number;
  readonly maxProjects: number;
  readonly maxFileBytes: number;
  readonly maxBodyBytes: number;
  readonly promptTimeoutMs: number;
  readonly permissionTimeoutMs: number;
  readonly eventsHeartbeatMs: number;
  readonly maxSseClients: number;
  readonly allowedOrigins: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly defaultModel?: string;
  readonly configFile: string;
  readonly configFileExists: boolean;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

const intOr = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const listOf = (value: string | undefined, separator: string): string[] =>
  (value ?? "")
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

export const resolveRoots = (value: string | undefined, serverCwd: string): string[] =>
  listOf(value, ":")
    .map((root) => resolve(serverCwd, root))
    .filter(isUsableRoot);

export const resolveDefaultCwd = (value: string | undefined, serverCwd: string): string => {
  const resolved = resolve(serverCwd, value ?? serverCwd);
  return isUsableRoot(resolved) ? resolved : serverCwd;
};

const SENSITIVE_PARAM = /key|secret|token|password/i;

export const redactUrl = (value: string): string => {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(key)) url.searchParams.set(key, "***");
    }
    return url.toString();
  } catch {
    return "invalid URL";
  }
};

export const parseAcpUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
};

const CONFIG_FILE_NAME = "grok-build-web.config.json";
const DEFAULT_ACP_URL = "ws://127.0.0.1:2419/ws";
const FILE_FIELDS: readonly string[] = ["acpUrl", "acpSecret", "defaultCwd", "defaultModel"];

/** Parsed config file. Absent keys fall through to the environment; an empty string is a value. */
interface ConfigFile {
  readonly exists: boolean;
  readonly acpUrl?: string;
  readonly acpSecret?: string;
  readonly defaultCwd?: string;
  readonly defaultModel?: string;
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const fileString = (
  record: Record<string, unknown>,
  field: string,
  configFile: string,
): string | undefined => {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid config file ${configFile}: field "${field}" must be a string`);
  }
  return value;
};

const fileAcpUrl = (record: Record<string, unknown>, configFile: string): string | undefined => {
  const value = fileString(record, "acpUrl", configFile);
  if (value === undefined) return undefined;
  const url = parseAcpUrl(value);
  if (url === undefined) {
    throw new Error(
      `Invalid config file ${configFile}: field "acpUrl" must be a ws:// or wss:// URL`,
    );
  }
  return url;
};

const fileDefaultCwd = (
  record: Record<string, unknown>,
  configFile: string,
  serverCwd: string,
): string | undefined => {
  const value = fileString(record, "defaultCwd", configFile);
  if (value === undefined) return undefined;
  const resolved = resolve(serverCwd, value);
  if (!isUsableRoot(resolved)) {
    throw new Error(
      `Invalid config file ${configFile}: field "defaultCwd" is not a usable directory`,
    );
  }
  return resolved;
};

const readConfigFile = (configFile: string, serverCwd: string, explicit: boolean): ConfigFile => {
  let text: string;
  try {
    text = readFileSync(configFile, "utf8");
  } catch (cause) {
    // Only the default path is optional. A missing file named by GROK_WEB_CONFIG is a typo that
    // would otherwise start the server without the secret the operator thought they had set.
    if (!explicit && (cause as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw new Error(`Cannot read config file ${configFile}: ${messageOf(cause)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`Invalid config file ${configFile}: ${messageOf(cause)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid config file ${configFile}: expected a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  // Unknown keys are rejected because a misspelled field would silently keep the environment value.
  const unknown = Object.keys(record).filter((key) => !FILE_FIELDS.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `Invalid config file ${configFile}: unknown field(s) ${unknown
        .map((key) => `"${key}"`)
        .join(", ")}`,
    );
  }
  return {
    exists: true,
    acpUrl: fileAcpUrl(record, configFile),
    acpSecret: fileString(record, "acpSecret", configFile),
    defaultCwd: fileDefaultCwd(record, configFile, serverCwd),
    defaultModel: fileString(record, "defaultModel", configFile),
  };
};

const envAcpUrl = (value: string | undefined): string => {
  const raw = nonEmpty(value);
  if (raw === undefined) return DEFAULT_ACP_URL;
  const url = parseAcpUrl(raw);
  if (url === undefined) {
    throw new Error(`Invalid GROK_ACP_URL: must be a ws:// or wss:// URL`);
  }
  return url;
};

export const loadConfig = (
  env: Record<string, string | undefined> = process.env,
  serverCwd: string = process.cwd(),
): ServerConfig => {
  const explicit = nonEmpty(env["GROK_WEB_CONFIG"]);
  const configFile = resolve(serverCwd, explicit ?? CONFIG_FILE_NAME);
  const file = readConfigFile(configFile, serverCwd, explicit !== undefined);
  return {
    acpUrl: file.acpUrl ?? envAcpUrl(env["GROK_ACP_URL"]),
    acpSecret: nonEmpty(file.acpSecret ?? env["GROK_ACP_SECRET"] ?? env["GROK_AGENT_SECRET"]),
    port: intOr(env["PORT"], 3000),
    host: env["HOST"] ?? "127.0.0.1",
    serverCwd,
    allowedRoots: resolveRoots(env["GROK_WEB_ALLOWED_ROOTS"], serverCwd),
    defaultCwd: file.defaultCwd ?? resolveDefaultCwd(env["GROK_WEB_DEFAULT_CWD"], serverCwd),
    readOnly: env["GROK_WEB_READ_ONLY"] === "1",
    maxTerminals: intOr(env["GROK_WEB_MAX_TERMINALS"], 8),
    terminalOutputLimit: intOr(env["GROK_WEB_TERMINAL_OUTPUT_LIMIT"], 1_048_576),
    maxTasks: intOr(env["GROK_WEB_MAX_TASKS"], 100),
    maxProjects: intOr(env["GROK_WEB_MAX_PROJECTS"], 50),
    maxFileBytes: intOr(env["GROK_WEB_MAX_FILE_BYTES"], 2_097_152),
    maxBodyBytes: intOr(env["GROK_WEB_MAX_BODY_BYTES"], 262_144),
    promptTimeoutMs: intOr(env["GROK_WEB_PROMPT_TIMEOUT_MS"], 1_800_000),
    permissionTimeoutMs: intOr(env["GROK_WEB_PERMISSION_TIMEOUT_MS"], 300_000),
    eventsHeartbeatMs: intOr(env["GROK_WEB_EVENTS_HEARTBEAT_MS"], 15_000),
    maxSseClients: intOr(env["GROK_WEB_MAX_SSE_CLIENTS"], 16),
    allowedOrigins: listOf(env["GROK_WEB_ALLOWED_ORIGINS"], ","),
    allowedHosts: listOf(env["GROK_WEB_ALLOWED_HOSTS"], ","),
    defaultModel: nonEmpty(file.defaultModel ?? env["GROK_WEB_DEFAULT_MODEL"]),
    configFile,
    configFileExists: file.exists,
  };
};
