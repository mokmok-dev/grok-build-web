import { Data, Effect, Exit, Stream } from "effect";
import type { HttpServerRequest } from "effect/http";

const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
const DEV_PORTS = [5173, 4173];

export interface RequestGuardPolicy {
  readonly hosts: readonly string[];
  readonly origins: readonly string[];
  readonly devPorts: readonly number[];
}

export interface GuardDecision {
  readonly status: number;
  readonly message: string;
}

const stripBrackets = (hostname: string): string => hostname.replace(/^\[(.*)\]$/, "$1");

export const hostnameOf = (value: string): string | undefined => {
  try {
    return stripBrackets(new URL(`http://${value}`).hostname).toLowerCase();
  } catch {
    return undefined;
  }
};

export const hostsFor = (host: string, extra: readonly string[]): string[] => {
  const hosts = [...LOOPBACK];
  if (host !== "0.0.0.0" && host !== "::") hosts.push(host.toLowerCase());
  for (const entry of extra) hosts.push(entry.toLowerCase());
  return [...new Set(hosts)];
};

export const requestGuardPolicy = (config: {
  readonly host: string;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
}): RequestGuardPolicy => ({
  hosts: hostsFor(config.host, config.allowedHosts),
  origins: config.allowedOrigins,
  devPorts: DEV_PORTS,
});

const isLoopback = (hostname: string): boolean =>
  LOOPBACK.includes(stripBrackets(hostname).toLowerCase());

const parseOrigin = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url;
  } catch {
    return undefined;
  }
};

export const hostAllowed = (host: string | undefined, allowed: readonly string[]): boolean => {
  if (host === undefined || host === "") return false;
  const hostname = hostnameOf(host);
  return hostname !== undefined && allowed.includes(hostname);
};

export const originAllowed = (
  origin: string | undefined,
  host: string | undefined,
  policy: RequestGuardPolicy,
): boolean => {
  if (origin === undefined || origin === "") return true;
  if (origin === "null") return false;
  if (policy.origins.includes(origin)) return true;
  const parsed = parseOrigin(origin);
  if (parsed === undefined) return false;
  if (host !== undefined && parsed.host.toLowerCase() === host.toLowerCase()) return true;
  return isLoopback(parsed.hostname) && policy.devPorts.includes(Number(parsed.port));
};

export const checkRequest = (
  headers: Readonly<Record<string, string | undefined>>,
  policy: RequestGuardPolicy,
): GuardDecision | undefined => {
  const host = headers["host"];
  if (!hostAllowed(host, policy.hosts)) {
    return { status: 403, message: "Host is not allowed" };
  }
  if (!originAllowed(headers["origin"], host, policy)) {
    return { status: 403, message: "Origin is not allowed" };
  }
  return undefined;
};

export type BodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly message: string };

class BodyTooLarge extends Data.TaggedError("BodyTooLarge")<{}> {}

const decoder = new TextDecoder();

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const merged = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
};

export const readJsonBody = (
  request: HttpServerRequest.HttpServerRequest,
  limit: number,
): Effect.Effect<BodyResult> =>
  Effect.gen(function* () {
    const contentType = (request.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      return { ok: false as const, status: 415, message: "Expected application/json" };
    }
    const declared = Number(request.headers["content-length"] ?? "");
    if (Number.isFinite(declared) && declared > limit) {
      return { ok: false as const, status: 413, message: "Request body is too large" };
    }
    let size = 0;
    const chunks: Uint8Array[] = [];
    const collected = yield* request.stream.pipe(
      Stream.runForEach((chunk) =>
        Effect.suspend(() => {
          size += chunk.length;
          if (size > limit) return Effect.fail(new BodyTooLarge());
          chunks.push(chunk);
          return Effect.void;
        }),
      ),
      Effect.exit,
    );
    if (Exit.isFailure(collected)) {
      return { ok: false as const, status: 413, message: "Request body is too large" };
    }
    try {
      return { ok: true as const, value: JSON.parse(decoder.decode(concat(chunks))) };
    } catch {
      return { ok: false as const, status: 400, message: "Invalid JSON body" };
    }
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed({ ok: false as const, status: 400, message: "Cannot read the request body" }),
    ),
  );
