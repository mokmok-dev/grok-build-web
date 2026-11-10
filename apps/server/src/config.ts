import { AcpClient, isWithin } from "@grok-build-web/acp-client";
import { Context, Effect, Layer, Ref } from "effect";
import { resolve } from "node:path";
import { isUsableRoot } from "./paths.ts";
import { realpathOfExistingAncestor } from "./realpath.ts";

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
  readonly maxFileBytes: number;
  readonly maxBodyBytes: number;
  readonly promptTimeoutMs: number;
  readonly permissionTimeoutMs: number;
  readonly eventsHeartbeatMs: number;
  readonly maxSseClients: number;
  readonly allowedOrigins: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly defaultModel?: string;
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

export const loadConfig = (
  env: Record<string, string | undefined> = process.env,
  serverCwd: string = process.cwd(),
): ServerConfig => {
  return {
    acpUrl: env["GROK_ACP_URL"] ?? "ws://127.0.0.1:2419/ws",
    acpSecret: nonEmpty(env["GROK_ACP_SECRET"] ?? env["GROK_AGENT_SECRET"]),
    port: intOr(env["PORT"], 3000),
    host: env["HOST"] ?? "127.0.0.1",
    serverCwd,
    allowedRoots: resolveRoots(env["GROK_WEB_ALLOWED_ROOTS"], serverCwd),
    defaultCwd: resolveDefaultCwd(env["GROK_WEB_DEFAULT_CWD"], serverCwd),
    readOnly: env["GROK_WEB_READ_ONLY"] === "1",
    maxTerminals: intOr(env["GROK_WEB_MAX_TERMINALS"], 8),
    terminalOutputLimit: intOr(env["GROK_WEB_TERMINAL_OUTPUT_LIMIT"], 1_048_576),
    maxTasks: intOr(env["GROK_WEB_MAX_TASKS"], 100),
    maxFileBytes: intOr(env["GROK_WEB_MAX_FILE_BYTES"], 2_097_152),
    maxBodyBytes: intOr(env["GROK_WEB_MAX_BODY_BYTES"], 262_144),
    promptTimeoutMs: intOr(env["GROK_WEB_PROMPT_TIMEOUT_MS"], 1_800_000),
    permissionTimeoutMs: intOr(env["GROK_WEB_PERMISSION_TIMEOUT_MS"], 300_000),
    eventsHeartbeatMs: intOr(env["GROK_WEB_EVENTS_HEARTBEAT_MS"], 15_000),
    maxSseClients: intOr(env["GROK_WEB_MAX_SSE_CLIENTS"], 16),
    allowedOrigins: listOf(env["GROK_WEB_ALLOWED_ORIGINS"], ","),
    allowedHosts: listOf(env["GROK_WEB_ALLOWED_HOSTS"], ","),
    defaultModel: nonEmpty(env["GROK_WEB_DEFAULT_MODEL"]),
  };
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

export interface SettingsState {
  readonly url: string;
  readonly secret: string | undefined;
  readonly defaultCwd: string;
  readonly defaultModel: string | undefined;
  readonly readOnly: boolean;
}

export interface SettingsPatch {
  readonly url?: string;
  readonly secret?: string;
  readonly defaultCwd?: string;
  readonly defaultModel?: string;
}

export type SettingsUpdate =
  | { readonly ok: true; readonly state: SettingsState }
  | { readonly ok: false; readonly message: string };

export interface SettingsShape {
  readonly get: Effect.Effect<SettingsState>;
  readonly update: (patch: SettingsPatch) => Effect.Effect<SettingsUpdate>;
}

export class Settings extends Context.Service<Settings, SettingsShape>()(
  "@grok-build-web/server/Settings",
) {}

export const makeSettings = (
  config: ServerConfig,
): Effect.Effect<SettingsShape, never, AcpClient> =>
  Effect.gen(function* () {
    const client = yield* AcpClient;
    const ref = yield* Ref.make<SettingsState>({
      url: config.acpUrl,
      secret: config.acpSecret,
      defaultCwd: config.defaultCwd,
      defaultModel: config.defaultModel,
      readOnly: config.readOnly,
    });

    const update = (patch: SettingsPatch): Effect.Effect<SettingsUpdate> =>
      Effect.gen(function* () {
        const previous = yield* Ref.get(ref);
        const url = patch.url === undefined ? previous.url : parseAcpUrl(patch.url);
        if (url === undefined) {
          return { ok: false, message: "Invalid ACP WebSocket URL (expected ws:// or wss://)" };
        }
        let defaultCwd = previous.defaultCwd;
        if (patch.defaultCwd !== undefined) {
          // Canonicalise, so a symlink cannot install a root outside the allowed roots.
          const candidate = yield* Effect.promise(() =>
            realpathOfExistingAncestor(resolve(config.serverCwd, patch.defaultCwd ?? "")),
          );
          if (!isUsableRoot(candidate)) {
            return {
              ok: false,
              message: "The default working directory cannot be the filesystem root",
            };
          }
          if (config.allowedRoots.length > 0) {
            const serverRoot = yield* Effect.promise(() =>
              realpathOfExistingAncestor(config.serverCwd),
            );
            const roots = yield* Effect.promise(() =>
              Promise.all(config.allowedRoots.map(realpathOfExistingAncestor)),
            );
            if (
              !isWithin(candidate, serverRoot) &&
              !roots.some((root) => isWithin(candidate, root))
            ) {
              return {
                ok: false,
                message: "The default working directory is outside the allowed roots",
              };
            }
          }
          defaultCwd = candidate;
        }
        const next: SettingsState = {
          url,
          secret: patch.secret === "" ? undefined : (patch.secret ?? previous.secret),
          defaultCwd,
          defaultModel:
            patch.defaultModel === "" ? undefined : (patch.defaultModel ?? previous.defaultModel),
          readOnly: previous.readOnly,
        };
        yield* Ref.set(ref, next);
        if (next.url !== previous.url || next.secret !== previous.secret) {
          yield* client.reconfigure(next.url, next.secret);
        }
        return { ok: true, state: next };
      });

    return { get: Ref.get(ref), update };
  });

export const settingsLayer = (config: ServerConfig): Layer.Layer<Settings, never, AcpClient> =>
  Layer.effect(Settings, makeSettings(config));
