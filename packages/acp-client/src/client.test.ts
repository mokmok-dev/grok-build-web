import type { AddressInfo } from "node:net";
import { NodeSocket } from "@effect/platform-node";
import { Effect, Exit, Fiber, Option, Stream } from "effect";
import { WebSocketServer, type WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import {
  AcpClient,
  AcpError,
  connectionUrl,
  layer,
  type AcpClientConfig,
  type AcpClientShape,
  type IncomingRequest,
} from "./client.ts";
import type { ServerNotification } from "@grok-build-web/acp-protocol";

interface FakeServer {
  url: string;
  readonly frames: Record<string, unknown>[];
  readonly sockets: WebSocket[];
  readonly close: () => Promise<void>;
  readonly waitFor: (
    predicate: (frame: Record<string, unknown>) => boolean,
  ) => Promise<Record<string, unknown>>;
}

type Handler = (socket: WebSocket, message: Record<string, unknown>) => void;

const startFake = async (handler?: Handler): Promise<FakeServer> => {
  const wss = new WebSocketServer({ port: 0 });
  const frames: Record<string, unknown>[] = [];
  const sockets: WebSocket[] = [];
  const waiters: {
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
  }[] = [];
  const server: FakeServer = {
    url: "",
    frames,
    sockets,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.terminate();
        wss.close(() => resolve());
      }),
    waitFor: (predicate) => {
      const found = frames.find(predicate);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise((resolve) => {
        waiters.push({ predicate, resolve });
      });
    },
  };
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      frames.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
      handler?.(socket, message);
    });
  });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  server.url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`;
  return server;
};

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
    const server = await startFake(respondToInitialize);
    const result = await runClient({ url: server.url }, (client) =>
      client.request("initialize", { protocolVersion: 1 }),
    );
    expect(result).toEqual({ protocolVersion: 1 });
    expect(server.frames[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await server.close();
  });

  it("reports the connected status", async () => {
    const server = await startFake(respondToInitialize);
    const status = await runClient({ url: server.url }, (client) => client.status);
    expect(status.state).toBe("connected");
    expect(status.url).toBe(server.url);
    await server.close();
  });

  it("reports a failed connection", async () => {
    const status = await runClient({ url: "ws://127.0.0.1:1/ws" }, (client) => client.status);
    expect(status.state).toBe("error");
    expect(status.lastError).toBeDefined();
  });

  it("streams server notifications", async () => {
    const server = await startFake(respondToInitialize);
    const notification = await runClient({ url: server.url }, (client) =>
      Effect.gen(function* () {
        const fiber = yield* client.notifications.pipe(
          Stream.take(1),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Effect.sleep(50);
        send(firstSocket(server), {
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
    await server.close();
  });

  it("forwards server requests and their replies", async () => {
    const server = await startFake(respondToInitialize);
    await runClient({ url: server.url }, (client) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Stream.runHead(Stream.take(client.incomingRequests, 1)),
        );
        yield* Effect.sleep(50);
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
    );
    expect(reply["result"]).toEqual({ content: "hello" });
    await server.close();
  });

  it("rejects unsupported server requests", async () => {
    const server = await startFake(respondToInitialize);
    await runClient({ url: server.url }, (client) =>
      Effect.gen(function* () {
        yield* Effect.sleep(50);
        send(firstSocket(server), { jsonrpc: "2.0", id: 5, method: "nope", params: {} });
        yield* Effect.sleep(50);
        return yield* client.status;
      }),
    );
    const reply = await server.waitFor(
      (frame) => frame["id"] === 5 && frame["error"] !== undefined,
    );
    expect(reply["error"]).toMatchObject({ code: -32601 });
    await server.close();
  });

  it("surfaces server errors", async () => {
    const server = await startFake((socket, message) => {
      send(socket, {
        jsonrpc: "2.0",
        id: message["id"],
        error: { code: -32000, message: "boom" },
      });
    });
    const exit = await runClient({ url: server.url }, (client) =>
      client.request("initialize", {}).pipe(Effect.exit),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("boom");
    }
    await server.close();
  });

  it("times out unanswered requests", async () => {
    const server = await startFake();
    const exit = await runClient({ url: server.url }, (client) =>
      client.request("never", {}, 50).pipe(Effect.exit),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("timed out");
    }
    await server.close();
  });

  it("fails pending requests on disconnect", async () => {
    const server = await startFake();
    const exit = await runClient({ url: server.url }, (client) =>
      Effect.gen(function* () {
        const fiber = yield* client.request("never", {}, 0).pipe(Effect.exit, Effect.forkChild);
        yield* Effect.sleep(50);
        yield* client.disconnect;
        return yield* Fiber.join(fiber);
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    await server.close();
  });
});
