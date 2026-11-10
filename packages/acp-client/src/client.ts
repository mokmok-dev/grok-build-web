import type {
  ClientRequest,
  InitializeResult,
  JsonRpcId,
  ServerNotification,
} from "@grok-build-web/acp-protocol";
import {
  encodeError,
  encodeNotification,
  encodeRequest,
  encodeResult,
  isResponse,
  parseClientRequest,
  parseInitializeResult,
  parseJsonRpcMessage,
  parseServerNotification,
} from "@grok-build-web/acp-protocol";
import {
  Cause,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Ref,
  Scope,
  Stream,
} from "effect";
import { Socket } from "effect/socket";
import { defaultBackoff, nextDelay, type BackoffOptions } from "./backoff.ts";
import { allocate, emptyCorrelation, take, takeAll, type Correlation } from "./jsonrpc-client.ts";

export class AcpError extends Data.TaggedError("AcpError")<{ readonly message: string }> {}

export type AcpConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface AcpStatusInfo {
  readonly state: AcpConnectionState;
  readonly url: string;
  readonly lastError?: string;
}

export interface AcpClientConfig {
  readonly url: string;
  readonly secret?: string;
  readonly requestTimeoutMs?: number;
  readonly backoff?: BackoffOptions;
}

export interface IncomingRequest {
  readonly request: ClientRequest;
  readonly requestId: JsonRpcId;
  readonly reply: (result: unknown) => Effect.Effect<void>;
  readonly fail: (code: number, message: string) => Effect.Effect<void>;
}

export interface AcpClientShape {
  readonly status: Effect.Effect<AcpStatusInfo>;
  readonly statusChanges: Stream.Stream<AcpStatusInfo>;
  readonly notifications: Stream.Stream<ServerNotification>;
  readonly incomingRequests: Stream.Stream<IncomingRequest>;
  readonly connect: Effect.Effect<void>;
  readonly disconnect: Effect.Effect<void>;
  readonly reconfigure: (url: string, secret: string | undefined) => Effect.Effect<void>;
  readonly request: (
    method: string,
    params: unknown,
    requestTimeoutMs?: number,
  ) => Effect.Effect<unknown, AcpError>;
  readonly notify: (method: string, params: unknown) => Effect.Effect<void, AcpError>;
}

export class AcpClient extends Context.Service<AcpClient, AcpClientShape>()(
  "@grok-build-web/acp-client/AcpClient",
) {}

export const connectionUrl = (url: string, secret: string | undefined): string => {
  if (secret === undefined || secret === "") return url;
  const parsed = new URL(url);
  if (!parsed.searchParams.has("server-key")) parsed.searchParams.set("server-key", secret);
  return parsed.toString();
};

const decoder = new TextDecoder();

const decodeFrame = (frame: Uint8Array | string): string =>
  typeof frame === "string" ? frame : decoder.decode(frame);

export const make = (
  config: AcpClientConfig,
): Effect.Effect<AcpClientShape, never, Socket.WebSocketConstructor | Scope.Scope> =>
  Effect.gen(function* () {
    const urlRef = yield* Ref.make(connectionUrl(config.url, config.secret));
    const backoff = config.backoff ?? defaultBackoff;
    const requestTimeoutMs = config.requestTimeoutMs ?? 120_000;

    const statusRef = yield* Ref.make<AcpStatusInfo>({ state: "disconnected", url: "" });
    const statusPub = yield* PubSub.unbounded<AcpStatusInfo>();
    const notificationPub = yield* PubSub.unbounded<ServerNotification>();
    const requestPub = yield* PubSub.unbounded<IncomingRequest>();
    const correlation =
      yield* Ref.make<Correlation<Deferred.Deferred<unknown, AcpError>>>(emptyCorrelation());
    const writerRef = yield* Ref.make<Socket.Writer | undefined>(undefined);
    const attemptRef = yield* Ref.make(0);
    const startedRef = yield* Ref.make(false);
    const fiberRef = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined);
    const settledRef = yield* Ref.make(yield* Deferred.make<AcpStatusInfo>());
    const context = yield* Effect.context<Socket.WebSocketConstructor | Scope.Scope>();
    const url = () => Ref.get(urlRef);

    const publishStatus = (info: AcpStatusInfo) =>
      Effect.gen(function* () {
        yield* Ref.set(statusRef, info);
        yield* PubSub.publish(statusPub, info);
        if (info.state === "connected" || info.state === "error") {
          yield* Deferred.succeed(yield* Ref.get(settledRef), info);
        }
      });

    const replyFrame = (frame: string) =>
      Effect.gen(function* () {
        const writer = yield* Ref.get(writerRef);
        if (writer === undefined) return;
        yield* writer.write(frame).pipe(Effect.ignore);
      });

    const failPending = (message: string) =>
      Effect.gen(function* () {
        const [entries, next] = takeAll(yield* Ref.get(correlation));
        yield* Ref.set(correlation, next);
        for (const entry of entries) {
          yield* Deferred.fail(entry.token, new AcpError({ message }));
        }
      });

    const handleFrame = (raw: string) =>
      Effect.gen(function* () {
        const message = parseJsonRpcMessage(raw);
        if (message === undefined) return;
        if (isResponse(message)) {
          if (typeof message.id !== "number") return;
          const [entry, next] = take(yield* Ref.get(correlation), message.id);
          yield* Ref.set(correlation, next);
          if (entry === undefined) return;
          if ("error" in message) {
            yield* Deferred.fail(entry.token, new AcpError({ message: message.error.message }));
          } else {
            yield* Deferred.succeed(entry.token, message.result);
          }
          return;
        }
        if ("id" in message) {
          const request = parseClientRequest(message.method, message.params);
          if (request === undefined) {
            yield* replyFrame(
              encodeError(message.id, -32601, `Unsupported client method: ${message.method}`),
            );
            return;
          }
          yield* PubSub.publish(requestPub, {
            request,
            requestId: message.id,
            reply: (result) => replyFrame(encodeResult(message.id, result)),
            fail: (code, text) => replyFrame(encodeError(message.id, code, text)),
          });
          return;
        }
        const notification = parseServerNotification(message.method, message.params);
        if (notification !== undefined) yield* PubSub.publish(notificationPub, notification);
      });

    const connectAttempt = Effect.gen(function* () {
      yield* publishStatus({ state: "connecting", url: yield* url() });
      const socket = yield* Socket.makeWebSocket(yield* url());
      const writer = yield* socket.writer;
      yield* Ref.set(writerRef, writer);
      const reader = yield* socket.reader;
      yield* Ref.set(attemptRef, 0);
      yield* publishStatus({ state: "connected", url: yield* url() });
      yield* Effect.forever(
        Effect.gen(function* () {
          const frames = yield* reader.pull;
          for (const frame of frames) {
            yield* handleFrame(decodeFrame(frame));
          }
        }),
      );
    });

    const supervise = Effect.gen(function* () {
      for (;;) {
        const exit = yield* Effect.exit(Effect.scoped(connectAttempt));
        yield* Ref.set(writerRef, undefined);
        if (Exit.isSuccess(exit)) {
          yield* publishStatus({ state: "disconnected", url: yield* url() });
        } else {
          const message = Cause.pretty(exit.cause);
          yield* failPending(message);
          yield* publishStatus({ state: "error", url: yield* url(), lastError: message });
        }
        const attempt = yield* Ref.updateAndGet(attemptRef, (value) => value + 1);
        yield* Effect.sleep(nextDelay(attempt, backoff));
      }
    });

    const connect = Effect.gen(function* () {
      const started = yield* Ref.getAndSet(startedRef, true);
      if (started) return;
      yield* Ref.set(settledRef, yield* Deferred.make<AcpStatusInfo>());
      const fiber = yield* Effect.forkScoped(supervise);
      yield* Ref.set(fiberRef, fiber);
      yield* Deferred.await(yield* Ref.get(settledRef));
    }).pipe(Effect.provide(context));

    const disconnect = Effect.gen(function* () {
      const fiber = yield* Ref.get(fiberRef);
      if (fiber !== undefined) yield* Fiber.interrupt(fiber);
      yield* Ref.set(writerRef, undefined);
      yield* failPending("ACP client disconnected");
      yield* publishStatus({ state: "disconnected", url: yield* url() });
    });

    const reconfigure = (nextUrl: string, secret: string | undefined) =>
      Effect.gen(function* () {
        const fiber = yield* Ref.get(fiberRef);
        if (fiber !== undefined) yield* Fiber.interrupt(fiber);
        yield* Ref.set(urlRef, connectionUrl(nextUrl, secret));
        yield* Ref.set(startedRef, false);
        yield* Ref.set(writerRef, undefined);
        yield* failPending("ACP connection reconfigured");
        yield* publishStatus({ state: "disconnected", url: yield* url() });
        yield* Ref.set(settledRef, yield* Deferred.make<AcpStatusInfo>());
        const restarted = yield* Effect.forkScoped(supervise);
        yield* Ref.set(fiberRef, restarted);
        yield* Deferred.await(yield* Ref.get(settledRef));
      }).pipe(Effect.provide(context));

    const request = (method: string, params: unknown, timeoutOverride?: number) =>
      Effect.gen(function* () {
        const writer = yield* Ref.get(writerRef);
        if (writer === undefined) {
          return yield* new AcpError({ message: "ACP client is not connected" });
        }
        const deferred = yield* Deferred.make<unknown, AcpError>();
        const [id, next] = allocate(yield* Ref.get(correlation), method, deferred);
        yield* Ref.set(correlation, next);
        yield* writer
          .write(encodeRequest(id, method, params))
          .pipe(Effect.mapError((cause) => new AcpError({ message: String(cause) })));
        const awaited = Deferred.await(deferred);
        const timeout = timeoutOverride ?? requestTimeoutMs;
        if (timeout <= 0) return yield* awaited;
        const result = yield* Effect.timeoutOption(awaited, Duration.millis(timeout));
        if (Option.isNone(result)) {
          yield* Ref.update(correlation, (state) => take(state, id)[1]);
          return yield* new AcpError({ message: `ACP request timed out: ${method}` });
        }
        return result.value;
      });

    const notify = (method: string, params: unknown) =>
      Effect.gen(function* () {
        const writer = yield* Ref.get(writerRef);
        if (writer === undefined) {
          return yield* new AcpError({ message: "ACP client is not connected" });
        }
        yield* writer
          .write(encodeNotification(method, params))
          .pipe(Effect.mapError((cause) => new AcpError({ message: String(cause) })));
      });

    return {
      status: Ref.get(statusRef),
      statusChanges: Stream.fromPubSub(statusPub),
      notifications: Stream.fromPubSub(notificationPub),
      incomingRequests: Stream.fromPubSub(requestPub),
      connect,
      disconnect,
      reconfigure,
      request,
      notify,
    };
  });

export const layer = (
  config: AcpClientConfig,
): Layer.Layer<AcpClient, never, Socket.WebSocketConstructor> =>
  Layer.effect(AcpClient, make(config));

export const initialize = (client: AcpClientShape): Effect.Effect<InitializeResult, AcpError> =>
  client
    .request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    })
    .pipe(Effect.map(parseInitializeResult));
