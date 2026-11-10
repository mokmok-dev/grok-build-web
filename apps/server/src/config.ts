import { Context, Effect, Layer, Ref } from "effect";
import { AcpClient } from "@grok-build-web/acp-client";

export interface ServerConfig {
  readonly acpUrl: string;
  readonly acpSecret?: string;
  readonly port: number;
  readonly host: string;
  readonly allowedRoots: readonly string[];
  readonly readOnly: boolean;
  readonly maxTerminals: number;
  readonly terminalOutputLimit: number;
  readonly defaultCwd: string;
  readonly defaultModel?: string;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

const intOr = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const splitRoots = (value: string | undefined): string[] =>
  (value ?? "")
    .split(":")
    .map((root) => root.trim())
    .filter((root) => root !== "");

export const loadConfig = (
  env: Record<string, string | undefined> = process.env,
): ServerConfig => ({
  acpUrl: env["GROK_ACP_URL"] ?? "ws://127.0.0.1:2419/ws",
  acpSecret: nonEmpty(env["GROK_ACP_SECRET"] ?? env["GROK_AGENT_SECRET"]),
  port: intOr(env["PORT"], 3000),
  host: env["HOST"] ?? "127.0.0.1",
  allowedRoots: splitRoots(env["GROK_WEB_ALLOWED_ROOTS"]),
  readOnly: env["GROK_WEB_READ_ONLY"] === "1",
  maxTerminals: intOr(env["GROK_WEB_MAX_TERMINALS"], 8),
  terminalOutputLimit: intOr(env["GROK_WEB_TERMINAL_OUTPUT_LIMIT"], 1_048_576),
  defaultCwd: env["GROK_WEB_DEFAULT_CWD"] ?? process.cwd(),
  defaultModel: nonEmpty(env["GROK_WEB_DEFAULT_MODEL"]),
});

export const redactUrl = (url: string): string => {
  const parsed = new URL(url);
  if (parsed.searchParams.has("server-key")) parsed.searchParams.set("server-key", "***");
  return parsed.toString();
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

export interface SettingsShape {
  readonly get: Effect.Effect<SettingsState>;
  readonly update: (patch: SettingsPatch) => Effect.Effect<SettingsState>;
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

    const update = (patch: SettingsPatch) =>
      Effect.gen(function* () {
        const previous = yield* Ref.get(ref);
        const next: SettingsState = {
          url: patch.url ?? previous.url,
          secret: patch.secret ?? previous.secret,
          defaultCwd: patch.defaultCwd ?? previous.defaultCwd,
          defaultModel: patch.defaultModel ?? previous.defaultModel,
          readOnly: previous.readOnly,
        };
        yield* Ref.set(ref, next);
        const connectionChanged = next.url !== previous.url || next.secret !== previous.secret;
        if (connectionChanged) {
          yield* client.reconfigure(next.url, next.secret);
        }
        return next;
      });

    return { get: Ref.get(ref), update };
  });

export const settingsLayer = (config: ServerConfig): Layer.Layer<Settings, never, AcpClient> =>
  Layer.effect(Settings, makeSettings(config));
