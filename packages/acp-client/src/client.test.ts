import type { AddressInfo } from "node:net";
import { NodeSocket } from "@effect/platform-node";
import { Effect, Exit, Fiber, Option, Stream } from "effect";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerNotification } from "@grok-build-web/acp-protocol";
import {
  AcpClient,
  AcpError,
  connectionUrl,
  layer,
  type AcpClientConfig,
  type AcpClientShape,
  type IncomingRequest,
} from "./client.ts";

type Frame = Record<string, unknown>;

interface FakeServer {
  url: string;
  readonly frames: Frame[];
  readonly sockets: WebSocket[];
  readonly close: () => Promise<void>;
  readonly broadcast: (value: unknown) => void;
  readonly waitFor: (predicate: (frame: Frame) => boolean, label: string) => Promise<Frame>;
}

type Handler = (socket: WebSocket, message: Frame) => void;
interface ServerOptions {
  readonly onMessage?: Handler;
  readonly onConnect?: (socket: WebSocket) => void;
}

const servers: FakeServer[] = [];

const startFake = async (options: ServerOptions = {}): Promise<FakeServer> => {
  const wss = new WebSocketServer({ port: 0 });
  const frames: Frame[] = [];
  const sockets: WebSocket[] = [];
  const waiters: { predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = [];

  const server: FakeServer = {
    url: "",
    frames,
    sockets,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.terminate();
        wss.close(() => resolve());
      }),
    broadcast: (value) => {
      for (const socket of sockets) socket.send(JSON.stringify(value));
    },
    waitFor: (predicate, label) => {
      const found = frames.find(predicate);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 2_000);
        waiters.push({
          predicate,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
  };

  wss.on("connection", (socket) => {
    sockets.push(socket);
    options.onConnect?.(socket);
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Frame;
      frames.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
      options.onMessage?.(socket, message);
    });
  });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  server.url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`;
  servers.push(server);
  return server;
};

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

const runClient = async <A>(
  config: AcpClientConfig,
  use: (client: AcpClientShape) => Effect.Effect<A, AcpError>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* AcpClient;
      yield* client.connect;
      return yield* use(client);
    }).pipe(
      Effect.orDie,
      Effect.provide(layer(config)),
      Effect.provide(NodeSocket.layerWebSocketConstructor),
    ),
  );

const withoutConnect = async <A>(
  config: AcpClientConfig,
  use: (client: AcpClientShape) => Effect.Effect<A, AcpError>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* AcpClient;
      return yield* use(client);
    }).pipe(
      Effect.orDie,
      Effect.provide(layer(config)),
      Effect.provide(NodeSocket.layerWebSocketConstructor),
    ),
  );

const send = (socket: WebSocket, value: unknown): void => {
  socket.send(JSON.stringify(value));
};

const firstSocket = (server: FakeServer): WebSocket => {
  const socket = server.sockets[0];
  if (socket === undefined) throw new Error("no socket");
  return socket;
};

const respondToInitialize: Handler = (socket, message) => {
  if (message["method"] === "initialize") {
    send(socket, { jsonrpc: "2.0", id: message["id"], result: { protocolVersion: 1 } });
  }
};

const failureText = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  return String(exit.cause);
};

describe("connectionUrl", () => {
  it("leaves a url without a secret untouched", () => {
    expect(connectionUrl("ws://127.0.0.1:2419/ws", undefined)).toBe("ws://127.0.0.1:2419/ws");
    expect(connectionUrl("ws://127.0.0.1:2419/ws", "")).toBe("ws://127.0.0.1:2419/ws");
  });

  it("adds the secret", () => {
    expect(connectionUrl("ws://127.0.0.1:2419/ws", "s3cret")).toBe(
      "ws://127.0.0.1:2419/ws?server-key=s3cret",
    );
  });

  it("keeps an existing server key", () => {
    expect(connectionUrl("ws://127.0.0.1:2419/ws?server-key=old", "new")).toBe(
      "ws://127.0.0.1:2419/ws?server-key=old",
    );
  });
});

describe("AcpClient", () => {
  it("correlates responses to requests", async () => {
    const server = await startFake({ onMessage: respondToInitialize });
    const result = await runClient({ url: server.url }, (client) =>
      client.request("initialize", { protocolVersion: 1 }),
    );
    expect(result).toEqual({ protocolVersion: 1 });
    expect(server.frames[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "initialize" });
  });

  it("reports the connected status", async () => {
    const server = await startFake({ onMessage: respondToInitialize });
    const status = await runClient({ url: server.url }, (client) => client.status);
    expect(status.state).toBe("connected");
    expect(status.url).toBe(server.url);
  });

  it("reports a failed connection", async () => {
    const status = await runClient({ url: "ws://127.0.0.1:1/ws" }, (client) => client.status);
    expect(status.state).toBe("error");
    expect(status.lastError).toBeDefined();
  });

  it("sends notifications", async () => {
    const server = await startFake({ onMessage: respondToInitialize });
    await runClient({ url: server.url }, (client) =>
      client.notify("session/cancel", { sessionId: "s1" }),
    );
    const frame = await server.waitFor(
      (message) => message["method"] === "session/cancel",
      "the cancel notification",
    );
    expect(frame["id"]).toBeUndefined();
    expect(frame["params"]).toEqual({ sessionId: "s1" });
  });

  it("refuses notifications before connecting", async () => {
    const server = await startFake({ onMessage: respondToInitialize });
    const exit = await withoutConnect({ url: server.url }, (client) =>
      client.notify("session/cancel", { sessionId: "s1" }).pipe(Effect.exit),
    );
    expect(failureText(exit)).toContain("not connected");
  });

  it("refuses requests before connecting", async () => {
    const server = await startFake({ onMessage: respondToInitialize });
    const exit = await withoutConnect({ url: server.url }, (client) =>
      client.request("initialize", {}).pipe(Effect.exit),
    );
    expect(failureText(exit)).toContain("not connected");
  });

  it("ignores malformed frames and unknown ids", async () => {
    const server = await startFake({
      onConnect: (socket) => {
        socket.send("not json at all");
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: "text-id", result: {} }));
        send(socket, { jsonrpc: "2.0", id: 9_999, result: { ignored: true } });
        send(socket, { jsonrpc: "2.0", id: 9_999, error: { code: 1, message: "ignored" } });
      },
      onMessage: respondToInitialize,
    });
    const result = await runClient({ url: server.url }, (client) =>
      client.request("initialize", {}),
    );
    expect(result).toEqual({ protocolVersion: 1 });
  });

  it("streams server notifications", async () => {
    const server = await startFake({ onMessage: respondToInitialize });
    const notification = await runClient({ url: server.url }, (client) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Stream.runHead(Stream.take(client.notifications, 1)),
          {
            startImmediately: true,
          },
        );
        server.broadcast({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "s1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hi" },
            },
          },
        });
        const result = yield* Fiber.join(fiber);
        return Option.isSome(result) ? (result.value as ServerNotification) : undefined;
      }),
    );
    expect(notification).toMatchObject({ kind: "session_update", sessionId: "s1" });
  });

  it("forwards server requests and their replies", async () => {
    const server = await startFake({ onMessage: respondToInitialize });
    await runClient({ url: server.url }, (client) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Stream.runHead(Stream.take(client.incomingRequests, 1)),
          { startImmediately: true },
        );
        send(firstSocket(server), {
          jsonrpc: "2.0",
          id: 77,
          method: "fs/read_text_file",
          params: { sessionId: "s1", path: "/tmp/x" },
        });
        const result = yield* Fiber.join(fiber);
        if (Option.isNone(result)) throw new Error("expected a request");
        const request = result.value as IncomingRequest;
        expect(request.request).toMatchObject({ kind: "fs_read", path: "/tmp/x" });
        yield* request.reply({ content: "hello" });
      }),
    );
    const reply = await server.waitFor(
      (frame) => frame["id"] === 77 && frame["result"] !== undefined,
      "the fs reply",
    );
    expect(reply["result"]).toEqual({ content: "hello" });
  });

  it("rejects unsupported server requests", async () => {
    const server = await startFake({ onMessage: respondToInitialize });
    await runClient({ url: server.url }, (client) =>
      Effect.gen(function* () {
        send(firstSocket(server), { jsonrpc: "2.0", id: 5, method: "nope", params: {} });
        return yield* client.request("initialize", {});
      }),
    );
    const reply = await server.waitFor(
      (frame) => frame["id"] === 5 && frame["error"] !== undefined,
      "the -32601 reply",
    );
    expect(reply["error"]).toMatchObject({ code: -32601 });
  });

  it("surfaces server errors", async () => {
    const server = await startFake({
      onMessage: (socket, message) => {
        send(socket, {
          jsonrpc: "2.0",
          id: message["id"],
          error: { code: -32000, message: "boom" },
        });
      },
    });
    const exit = await runClient({ url: server.url }, (client) =>
      client.request("initialize", {}).pipe(Effect.exit),
    );
    expect(failureText(exit)).toContain("boom");
  });

  it("times out unanswered requests", async () => {
    const server = await startFake();
    const exit = await runClient({ url: server.url }, (client) =>
      client.request("never", {}, 50).pipe(Effect.exit),
    );
    expect(failureText(exit)).toContain("timed out: never");
  });

  it("fails pending requests when the server closes the socket", async () => {
    const server = await startFake({
      onMessage: (socket, message) => {
        if (message["method"] === "hang") socket.close();
      },
    });
    const exit = await runClient({ url: server.url }, (client) =>
      client.request("hang", {}, 0).pipe(Effect.timeout("2 seconds"), Effect.exit),
    );
    expect(failureText(exit)).toContain("SocketError");
  });

  it("fails pending requests on disconnect", async () => {
    const server = await startFake();
    const exit = await runClient({ url: server.url }, (client) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(client.request("never", {}, 0).pipe(Effect.exit), {
          startImmediately: true,
        });
        yield* client.disconnect;
        return yield* Fiber.join(fiber);
      }),
    );
    expect(failureText(exit)).toContain("disconnected");
  });

  it("reconnects to a reconfigured url", async () => {
    const first = await startFake({ onMessage: respondToInitialize });
    const second = await startFake({ onMessage: respondToInitialize });
    const result = await runClient({ url: first.url }, (client) =>
      Effect.gen(function* () {
        const before = yield* client.request("initialize", {});
        yield* client.reconfigure(second.url, undefined);
        const after = yield* client.request("initialize", {});
        const status = yield* client.status;
        return { before, after, status };
      }),
    );
    expect(result.before).toEqual({ protocolVersion: 1 });
    expect(result.after).toEqual({ protocolVersion: 1 });
    expect(result.status.state).toBe("connected");
    expect(second.frames.map((frame) => frame["method"])).toContain("initialize");
  });

  it("keeps working after an interrupted request", async () => {
    const server = await startFake({ onMessage: respondToInitialize });
    const result = await runClient({ url: server.url }, (client) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(client.request("never", {}, 0).pipe(Effect.exit), {
          startImmediately: true,
        });
        yield* Fiber.interrupt(fiber);
        return yield* client.request("initialize", {});
      }),
    );
    expect(result).toEqual({ protocolVersion: 1 });
  });
});
