import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { HttpRouter } from "effect/http";
import { appLayer } from "../src/app.ts";
import { loadConfig, type ServerConfig } from "../src/config.ts";

type Frame = Record<string, unknown>;

interface FakeOptions {
  readonly failPrompts?: boolean;
  readonly promptDelayMs?: number;
}

interface FakeAcp {
  readonly url: string;
  readonly methods: string[];
  readonly prompts: string[];
  readonly received: Frame[];
  readonly sendRequest: (id: number, method: string, params: unknown) => void;
  readonly sendNotification: (method: string, params: unknown) => void;
  readonly waitForFrame: (predicate: (frame: Frame) => boolean, label: string) => Promise<Frame>;
  readonly close: () => Promise<void>;
}

const startFakeAcp = async (options: FakeOptions = {}): Promise<FakeAcp> => {
  const wss = new WebSocketServer({ port: 0 });
  const methods: string[] = [];
  const prompts: string[] = [];
  const received: Frame[] = [];
  const sockets: WebSocket[] = [];
  const waiters: { predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = [];
  let sessions = 0;

  const write = (socket: WebSocket, value: unknown): void => {
    socket.send(JSON.stringify(value));
  };
  const respond = (socket: WebSocket, id: unknown, result: unknown): void => {
    write(socket, { jsonrpc: "2.0", id, result });
  };
  const failReply = (socket: WebSocket, id: unknown, code: number, message: string): void => {
    write(socket, { jsonrpc: "2.0", id, error: { code, message } });
  };
  const notify = (method: string, params: unknown): void => {
    for (const socket of sockets) write(socket, { jsonrpc: "2.0", method, params });
  };

  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Frame;
      received.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
      const id = message["id"];
      const method = typeof message["method"] === "string" ? message["method"] : undefined;
      if (id === undefined || method === undefined) return;
      methods.push(method);
      switch (method) {
        case "initialize":
          respond(socket, id, {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
            authMethods: [],
            _meta: {
              currentWorkingDirectory: "/tmp",
              modelState: {
                currentModelId: "test-model",
                availableModels: [{ modelId: "test-model" }],
              },
              availableCommands: [{ name: "help" }],
            },
          });
          return;
        case "session/new": {
          sessions += 1;
          const sessionId = `session-${sessions}`;
          respond(socket, id, {
            sessionId,
            models: { currentModelId: "test-model", availableModels: [{ modelId: "test-model" }] },
            configOptions: [{ id: "model" }],
          });
          return;
        }
        case "session/prompt": {
          const params = (message["params"] ?? {}) as Record<string, unknown>;
          const sessionId = String(params["sessionId"]);
          const prompt = params["prompt"] as Array<{ text?: string }> | undefined;
          prompts.push(prompt?.[0]?.text ?? "");
          if (options.failPrompts === true) {
            failReply(socket, id, -32000, "model exploded");
            return;
          }
          setTimeout(() => {
            notify("session/update", {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "pong" },
                messageId: "m1",
              },
            });
            notify("_x.ai/session_notification", {
              sessionId,
              update: { sessionUpdate: "turn_completed", usage: { totalTokens: 3 } },
            });
            notify("_x.ai/session/prompt_complete", { sessionId, promptId: "p" });
            respond(socket, id, { stopReason: "end_turn", usage: { totalTokens: 3 } });
          }, options.promptDelayMs ?? 20);
          return;
        }
        case "session/cancel":
          // The real agent rejects the request form; cancellation is a notification.
          failReply(socket, id, -32601, "Method not found");
          return;
        case "session/close":
        case "session/set_config_option":
          respond(socket, id, {});
          return;
        default:
          failReply(socket, id, -32601, "unknown method");
      }
    });
  });

  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    methods,
    prompts,
    received,
    sendRequest: (id, method, params) => {
      const socket = sockets[0];
      if (socket === undefined) throw new Error("no socket");
      write(socket, { jsonrpc: "2.0", id, method, params });
    },
    sendNotification: (method, params) => notify(method, params),
    waitForFrame: (predicate, label) => {
      const found = received.find(predicate);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 3_000);
        waiters.push({
          predicate,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.terminate();
        wss.close(() => resolve());
      }),
  };
};

type Handler = (request: Request) => Promise<Response>;

const call = (
  handler: Handler,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  handler(
    new Request(`http://127.0.0.1:3000${path}`, {
      method,
      headers: {
        host: "127.0.0.1:3000",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

const rawCall = (
  handler: Handler,
  method: string,
  path: string,
  init: { readonly body?: string; readonly headers?: Record<string, string> },
): Promise<Response> =>
  handler(
    new Request(`http://127.0.0.1:3000${path}`, {
      method,
      headers: { host: "127.0.0.1:3000", ...init.headers },
      body: init.body,
    }),
  );

const json = async <A>(response: Response): Promise<A> => (await response.json()) as A;

interface Harness {
  readonly handler: Handler;
  readonly dispose: () => Promise<void>;
  readonly acp: FakeAcp;
  readonly cwd: string;
}

const harnesses: Harness[] = [];

const startHarness = async (
  options: FakeOptions & { readonly env?: Record<string, string> } = {},
): Promise<Harness> => {
  const acp = await startFakeAcp(options);
  const cwd = await mkdtemp(join(tmpdir(), "grok-web-server-"));
  const config: ServerConfig = loadConfig({
    GROK_ACP_URL: acp.url,
    GROK_ACP_SECRET: "testsecret",
    GROK_WEB_DEFAULT_CWD: cwd,
    ...options.env,
  });
  const { handler, dispose } = HttpRouter.toWebHandler(appLayer(config), { disableLogger: true });
  const harness: Harness = { handler, dispose, acp, cwd };
  harnesses.push(harness);
  return harness;
};

const waitFor = async <A>(probe: () => Promise<A | undefined>, timeoutMs = 4000): Promise<A> => {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const connected = async (harness: Harness): Promise<true> =>
  waitFor(async () => {
    const health = await json<{ acp?: { connected: boolean } }>(
      await call(harness.handler, "GET", "/api/health"),
    );
    return health.acp?.connected === true ? true : undefined;
  });

const createTask = async (harness: Harness, body: unknown = {}): Promise<{ id: string }> =>
  json<{ id: string }>(await call(harness.handler, "POST", "/api/tasks", body));

const sseReader = (response: Response) => {
  const body = response.body;
  if (body === null) throw new Error("no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  return {
    readUntil: async (predicate: (value: string) => boolean): Promise<string> => {
      const deadline = Date.now() + 4_000;
      while (!predicate(text)) {
        if (Date.now() > deadline) throw new Error(`timed out reading SSE: ${text}`);
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text;
    },
    cancel: () => reader.cancel(),
  };
};

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.dispose();
    await harness.acp.close();
  }
});

describe("server", () => {
  it("reports health and settings", async () => {
    const harness = await startHarness();
    await connected(harness);
    const health = await json<{ ok: boolean; acp: { connected: boolean; url: string } }>(
      await call(harness.handler, "GET", "/api/health"),
    );
    expect(health.ok).toBe(true);
    expect(health.acp.connected).toBe(true);
    expect(health.acp.url).not.toContain("testsecret");

    const settings = await json<{ hasSecret: boolean; defaultCwd: string; readOnly: boolean }>(
      await call(harness.handler, "GET", "/api/settings"),
    );
    expect(settings.hasSecret).toBe(true);
    expect(settings.defaultCwd).toBe(harness.cwd);
    expect(settings.readOnly).toBe(false);
  });

  it("creates a task, streams a prompt and closes it", async () => {
    const harness = await startHarness();
    await connected(harness);

    const created = await call(harness.handler, "POST", "/api/tasks", {
      prompt: "Reply with the single word: pong",
    });
    const detail = await json<{
      id: string;
      status: string;
      yolo: boolean;
      messages: Array<{ role: string }>;
    }>(created);
    expect(detail.status).toBe("running");
    expect(detail.yolo).toBe(false);
    expect(detail.messages[0]).toMatchObject({ role: "user" });

    const tasks = await json<{ tasks: Array<{ id: string }> }>(
      await call(harness.handler, "GET", "/api/tasks"),
    );
    expect(tasks.tasks.map((task) => task.id)).toContain(detail.id);

    const idle = await waitFor(async () => {
      const current = await json<{
        status: string;
        messages: Array<{ role: string; parts: Array<{ text?: string }> }>;
      }>(await call(harness.handler, "GET", `/api/tasks/${detail.id}`));
      return current.status === "idle" &&
        current.messages.some((message) => message.parts.some((part) => part.text === "pong"))
        ? current
        : undefined;
    });
    expect(idle.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

    const closed = await call(harness.handler, "POST", `/api/tasks/${detail.id}/close`, {});
    expect(await json(closed)).toEqual({ closed: true });
    const after = await json<{ status: string }>(
      await call(harness.handler, "GET", `/api/tasks/${detail.id}`),
    );
    expect(after.status).toBe("closed");
    expect(harness.acp.methods).toContain("session/close");
  });

  it("sends follow-up prompts, cancels with a notification and rejects concurrent prompts", async () => {
    const harness = await startHarness({ promptDelayMs: 300 });
    await connected(harness);
    const detail = await createTask(harness);

    const accepted = await call(harness.handler, "POST", `/api/tasks/${detail.id}/prompt`, {
      text: "again",
    });
    expect(await json(accepted)).toEqual({ accepted: true });

    const concurrent = await call(harness.handler, "POST", `/api/tasks/${detail.id}/prompt`, {
      text: "too soon",
    });
    expect(concurrent.status).toBe(400);
    expect(await json<{ error: string }>(concurrent)).toMatchObject({
      error: "A prompt is already running for this task",
    });

    await waitFor(async () => {
      const current = await json<{ status: string }>(
        await call(harness.handler, "GET", `/api/tasks/${detail.id}`),
      );
      return current.status === "idle" ? true : undefined;
    });

    const cancel = await call(harness.handler, "POST", `/api/tasks/${detail.id}/cancel`, {});
    expect(await json(cancel)).toEqual({ accepted: true });
    const notification = await harness.acp.waitForFrame(
      (frame) => frame["method"] === "session/cancel" && frame["id"] === undefined,
      "the cancel notification",
    );
    expect(notification["params"]).toEqual({ sessionId: detail.id });
    expect(harness.acp.prompts).toEqual(["again"]);
  });

  it("streams an AG-UI turn over SSE", async () => {
    const harness = await startHarness();
    await connected(harness);
    const detail = await createTask(harness);

    const response = await call(harness.handler, "POST", `/api/tasks/${detail.id}/chat`, {
      threadId: detail.id,
      runId: "run-1",
      messages: [{ id: "m1", role: "user", content: "Reply with the single word: pong" }],
      tools: [],
      context: [],
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await sseReader(response).readUntil((text) => text.includes("RUN_FINISHED"));
    expect(body).toContain('"type":"RUN_STARTED"');
    expect(body).toContain('"messageId":"m1"');
    expect(body).toContain("pong");
    expect(body).toContain('"type":"TEXT_MESSAGE_END"');
    expect(body).toContain('"type":"RUN_FINISHED"');
  });

  it("uses the last user message, including content parts", async () => {
    const harness = await startHarness();
    await connected(harness);
    const detail = await createTask(harness);

    const response = await call(harness.handler, "POST", `/api/tasks/${detail.id}/chat`, {
      threadId: detail.id,
      runId: "run-2",
      messages: [
        { id: "m1", role: "user", content: "first" },
        {
          id: "m2",
          role: "user",
          content: [
            { type: "text", text: "part one" },
            { type: "text", content: " part two" },
          ],
        },
      ],
    });
    await sseReader(response).readUntil((text) => text.includes("RUN_FINISHED"));
    expect(harness.acp.prompts).toEqual(["part one part two"]);
  });

  it("cancels the turn when the browser aborts the stream", async () => {
    const harness = await startHarness({ promptDelayMs: 5_000 });
    await connected(harness);
    const detail = await createTask(harness);
    const response = await call(harness.handler, "POST", `/api/tasks/${detail.id}/chat`, {
      threadId: detail.id,
      runId: "run-abort",
      messages: [{ id: "m1", role: "user", content: "long task" }],
    });
    const body = response.body;
    if (body === null) throw new Error("no body");
    const reader = body.getReader();
    await reader.read();
    await reader.cancel();
    const cancel = await harness.acp.waitForFrame(
      (frame) => frame["method"] === "session/cancel" && frame["id"] === undefined,
      "the cancel notification",
    );
    expect(cancel["params"]).toEqual({ sessionId: detail.id });
  });

  it("sends an empty prompt when the run has no user message", async () => {
    const harness = await startHarness();
    await connected(harness);
    const detail = await createTask(harness);
    const response = await call(harness.handler, "POST", `/api/tasks/${detail.id}/chat`, {
      threadId: detail.id,
      runId: "run-empty",
      messages: [{ id: "m1", role: "assistant", content: "assistant only" }],
    });
    await sseReader(response).readUntil((text) => text.includes("RUN_FINISHED"));
    expect(harness.acp.prompts).toEqual([""]);
  });

  it("emits RUN_ERROR when the agent fails the prompt", async () => {
    const harness = await startHarness({ failPrompts: true });
    await connected(harness);
    const detail = await createTask(harness);
    const response = await call(harness.handler, "POST", `/api/tasks/${detail.id}/chat`, {
      threadId: detail.id,
      runId: "run-3",
      messages: [{ id: "m1", role: "user", content: "hi" }],
    });
    const body = await sseReader(response).readUntil((text) => text.includes("RUN_ERROR"));
    expect(body).toContain('"type":"RUN_ERROR"');
    expect(body).toContain("model exploded");
    const task = await json<{ status: string; lastError?: string }>(
      await call(harness.handler, "GET", `/api/tasks/${detail.id}`),
    );
    expect(task.status).toBe("error");
    expect(task.lastError).toBe("model exploded");
  });

  it("returns 404 for unknown tasks", async () => {
    const harness = await startHarness();
    await connected(harness);
    expect((await call(harness.handler, "GET", "/api/tasks/nope")).status).toBe(404);
    const chat = await call(harness.handler, "POST", "/api/tasks/nope/chat", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(chat.status).toBe(404);
  });

  it("streams the task list and live updates over SSE", async () => {
    const harness = await startHarness({ env: { GROK_WEB_EVENTS_HEARTBEAT_MS: "30" } });
    await connected(harness);
    const response = await call(harness.handler, "GET", "/api/events");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = sseReader(response);
    const first = await reader.readUntil((text) => text.includes('"type":"tasks"'));
    expect(first).toContain('"type":"tasks"');

    await createTask(harness);
    const second = await reader.readUntil(
      (text) => (text.match(/"type":"tasks"/g) ?? []).length >= 2,
    );
    expect((second.match(/"type":"tasks"/g) ?? []).length).toBeGreaterThanOrEqual(2);

    const heartbeats = await reader.readUntil((text) => text.includes("heartbeat"));
    expect(heartbeats).toContain('"type":"heartbeat"');
    await reader.cancel();
  });

  it("caps concurrent event streams", async () => {
    const harness = await startHarness({ env: { GROK_WEB_MAX_SSE_CLIENTS: "1" } });
    await connected(harness);
    const first = await call(harness.handler, "GET", "/api/events");
    const reader = sseReader(first);
    await reader.readUntil((text) => text.includes('"type":"tasks"'));
    const second = await call(harness.handler, "GET", "/api/events");
    expect(second.status).toBe(429);
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const third = await call(harness.handler, "GET", "/api/events");
    expect(third.status).toBe(200);
    await third.body?.cancel();
  });

  it("serves the agent capabilities and sends initialize parameters", async () => {
    const harness = await startHarness();
    await connected(harness);
    const agent = await json<{
      connected: boolean;
      models: { currentModelId?: string };
      availableCommands: unknown[];
      capabilities: Record<string, unknown>;
    }>(await call(harness.handler, "GET", "/api/agent"));
    expect(agent.connected).toBe(true);
    expect(agent.models.currentModelId).toBe("test-model");
    expect(agent.availableCommands).toHaveLength(1);
    expect(agent.capabilities).toEqual({ loadSession: true });

    const initialize = harness.acp.received.find((frame) => frame["method"] === "initialize");
    expect(initialize?.["params"]).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { terminal: true, fs: { readTextFile: true, writeTextFile: true } },
    });
  });

  it("rejects cross-site requests and non-JSON bodies", async () => {
    const harness = await startHarness();
    await connected(harness);

    const foreignHost = await rawCall(harness.handler, "GET", "/api/health", {
      headers: { host: "evil.example" },
    });
    expect(foreignHost.status).toBe(403);

    const foreignOrigin = await call(
      harness.handler,
      "POST",
      "/api/tasks",
      {},
      {
        origin: "http://evil.example",
      },
    );
    expect(foreignOrigin.status).toBe(403);

    const viteOrigin = await call(
      harness.handler,
      "POST",
      "/api/tasks",
      {},
      {
        origin: "http://localhost:5173",
      },
    );
    expect(viteOrigin.status).not.toBe(403);

    const textPlain = await rawCall(harness.handler, "POST", "/api/tasks", {
      body: "{}",
      headers: { "content-type": "text/plain" },
    });
    expect(textPlain.status).toBe(415);

    const tooLarge = await rawCall(harness.handler, "POST", "/api/tasks", {
      body: JSON.stringify({ cwd: harness.cwd, padding: "x".repeat(300_000) }),
      headers: { "content-type": "application/json" },
    });
    expect(tooLarge.status).toBe(413);

    const malformed = await rawCall(harness.handler, "POST", "/api/tasks", {
      body: "{",
      headers: { "content-type": "application/json" },
    });
    expect(malformed.status).toBe(400);
  });

  it("validates the task working directory", async () => {
    const harness = await startHarness();
    await connected(harness);
    expect((await call(harness.handler, "POST", "/api/tasks", { cwd: "/" })).status).toBe(400);
    expect((await call(harness.handler, "POST", "/api/tasks", { cwd: "/etc" })).status).toBe(400);
    expect(
      (await call(harness.handler, "POST", "/api/tasks", { cwd: join(harness.cwd, "sub") })).status,
    ).toBe(200);
  });

  it("allows an explicitly configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "grok-web-root-"));
    const harness = await startHarness({ env: { GROK_WEB_ALLOWED_ROOTS: root } });
    await connected(harness);
    const created = await call(harness.handler, "POST", "/api/tasks", { cwd: root });
    expect(created.status).toBe(200);
  });

  it("refuses mutations in read-only mode", async () => {
    const harness = await startHarness({ env: { GROK_WEB_READ_ONLY: "1" } });
    await connected(harness);
    const created = await call(harness.handler, "POST", "/api/tasks", {});
    expect(created.status).toBe(403);
    const prompt = await call(harness.handler, "POST", "/api/tasks/whatever/prompt", { text: "x" });
    expect(prompt.status).toBe(403);
    const chat = await call(harness.handler, "POST", "/api/tasks/whatever/chat", {
      messages: [{ role: "user", content: "x" }],
    });
    expect(chat.status).toBe(403);
  });

  it("enforces the task limit", async () => {
    const harness = await startHarness({ env: { GROK_WEB_MAX_TASKS: "1" } });
    await connected(harness);
    await createTask(harness);
    const second = await call(harness.handler, "POST", "/api/tasks", {});
    expect(second.status).toBe(400);
    expect(await json<{ error: string }>(second)).toMatchObject({
      error: "Task limit reached (1)",
    });
  });

  it("dispatches fs requests from the agent", async () => {
    const harness = await startHarness();
    await connected(harness);
    const detail = await createTask(harness);
    await writeFile(join(harness.cwd, "notes.txt"), "hello from disk");

    harness.acp.sendRequest(801, "fs/read_text_file", {
      sessionId: detail.id,
      path: "notes.txt",
    });
    const read = await harness.acp.waitForFrame(
      (frame) => frame["id"] === 801,
      "the fs read reply",
    );
    expect(read["result"]).toEqual({ content: "hello from disk" });

    harness.acp.sendRequest(802, "fs/read_text_file", {
      sessionId: detail.id,
      path: "../escape.txt",
    });
    const escape = await harness.acp.waitForFrame(
      (frame) => frame["id"] === 802,
      "the escape reply",
    );
    expect(String((escape["error"] as { message?: string }).message)).toContain(
      "outside the allowed roots",
    );

    harness.acp.sendRequest(803, "fs/write_text_file", {
      sessionId: detail.id,
      path: "written.txt",
      content: "written",
    });
    const write = await harness.acp.waitForFrame(
      (frame) => frame["id"] === 803,
      "the fs write reply",
    );
    expect(write["result"]).toEqual({});

    harness.acp.sendRequest(804, "fs/read_text_file", { sessionId: "missing", path: "x" });
    const unknown = await harness.acp.waitForFrame(
      (frame) => frame["id"] === 804,
      "the unknown session reply",
    );
    expect(String((unknown["error"] as { message?: string }).message)).toContain("Unknown session");
  });

  it("dispatches terminal requests from the agent and binds them to the session", async () => {
    const harness = await startHarness();
    await connected(harness);
    const detail = await createTask(harness);

    harness.acp.sendRequest(901, "terminal/create", {
      sessionId: detail.id,
      command: "node",
      args: ["-e", "process.stdout.write('hello')"],
    });
    const created = await harness.acp.waitForFrame(
      (frame) => frame["id"] === 901,
      "the terminal id",
    );
    const terminalId = (created["result"] as { terminalId: string }).terminalId;
    expect(terminalId).toBe("terminal-1");

    harness.acp.sendRequest(902, "terminal/output", { sessionId: detail.id, terminalId });
    const output = await harness.acp.waitForFrame(
      (frame) => frame["id"] === 902,
      "the terminal output",
    );
    expect(output["result"]).toMatchObject({ truncated: false });
    harness.acp.sendRequest(903, "terminal/wait_for_exit", { sessionId: detail.id, terminalId });
    const wait = await harness.acp.waitForFrame(
      (frame) => frame["id"] === 903,
      "the terminal exit",
    );
    expect((wait["result"] as { exitCode?: number }).exitCode).toBe(0);

    const other = await createTask(harness);
    harness.acp.sendRequest(904, "terminal/output", { sessionId: other.id, terminalId });
    const foreign = await harness.acp.waitForFrame(
      (frame) => frame["id"] === 904,
      "the foreign terminal reply",
    );
    expect(String((foreign["error"] as { message?: string }).message)).toContain(
      "Unknown terminal",
    );

    harness.acp.sendRequest(908, "terminal/output", { sessionId: "missing", terminalId });
    const noSession = await harness.acp.waitForFrame(
      (frame) => frame["id"] === 908,
      "the unknown session reply",
    );
    expect(String((noSession["error"] as { message?: string }).message)).toContain(
      "Unknown session",
    );

    harness.acp.sendRequest(905, "terminal/output", {
      sessionId: detail.id,
      terminalId: "terminal-404",
    });
    const missing = await harness.acp.waitForFrame(
      (frame) => frame["id"] === 905,
      "the missing terminal reply",
    );
    expect(String((missing["error"] as { message?: string }).message)).toContain(
      "Unknown terminal",
    );

    harness.acp.sendRequest(906, "terminal/kill", { sessionId: detail.id, terminalId });
    expect(
      await harness.acp.waitForFrame((frame) => frame["id"] === 906, "the kill reply"),
    ).toMatchObject({ result: {} });
    harness.acp.sendRequest(907, "terminal/release", { sessionId: detail.id, terminalId });
    expect(
      await harness.acp.waitForFrame((frame) => frame["id"] === 907, "the release reply"),
    ).toMatchObject({ result: {} });
  });

  it("rejects a terminal cwd outside the task and roots", async () => {
    const harness = await startHarness();
    await connected(harness);
    const detail = await createTask(harness);
    harness.acp.sendRequest(950, "terminal/create", {
      sessionId: detail.id,
      command: "true",
      args: [],
      cwd: "/etc",
    });
    const reply = await harness.acp.waitForFrame(
      (frame) => frame["id"] === 950,
      "the cwd rejection",
    );
    expect(String((reply["error"] as { message?: string }).message)).toContain(
      "outside the allowed roots",
    );
  });

  it("asks the browser for permission, then applies the decision", async () => {
    const harness = await startHarness();
    await connected(harness);
    const detail = await createTask(harness);
    const options = [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ];

    harness.acp.sendRequest(500, "session/request_permission", {
      sessionId: detail.id,
      toolCall: { toolCallId: "t1", title: "Run ls" },
      options,
    });
    const pending = await waitFor(async () => {
      const task = await json<{ status: string; pendingPermission?: { requestId: string } }>(
        await call(harness.handler, "GET", `/api/tasks/${detail.id}`),
      );
      return task.pendingPermission?.requestId === "500" ? task : undefined;
    });
    expect(pending.status).toBe("awaiting_permission");

    const decided = await call(harness.handler, "POST", `/api/tasks/${detail.id}/permission`, {
      requestId: "500",
      optionId: "allow_once",
    });
    expect(await json(decided)).toEqual({ accepted: true });
    const reply = await harness.acp.waitForFrame(
      (frame) => frame["id"] === 500,
      "the permission reply",
    );
    expect(reply["result"]).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });

    const after = await json<{ status: string; pendingPermission?: unknown }>(
      await call(harness.handler, "GET", `/api/tasks/${detail.id}`),
    );
    expect(after.status).toBe("idle");
    expect(after.pendingPermission).toBeUndefined();
  });

  it("denies permission and rejects unknown requests", async () => {
    const harness = await startHarness();
    await connected(harness);
    const detail = await createTask(harness);
    harness.acp.sendRequest(501, "session/request_permission", {
      sessionId: detail.id,
      toolCall: { toolCallId: "t1", title: "Run ls" },
      options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
    });
    await waitFor(async () => {
      const task = await json<{ pendingPermission?: { requestId: string } }>(
        await call(harness.handler, "GET", `/api/tasks/${detail.id}`),
      );
      return task.pendingPermission?.requestId === "501" ? true : undefined;
    });
    const denied = await call(harness.handler, "POST", `/api/tasks/${detail.id}/permission`, {
      requestId: "501",
      decision: "cancel",
    });
    expect(await json(denied)).toEqual({ accepted: true });
    const reply = await harness.acp.waitForFrame(
      (frame) => frame["id"] === 501,
      "the denial reply",
    );
    expect(reply["result"]).toEqual({ outcome: { outcome: "cancelled" } });

    const unknown = await call(harness.handler, "POST", `/api/tasks/${detail.id}/permission`, {
      requestId: "does-not-exist",
      optionId: "allow_once",
    });
    expect(unknown.status).toBe(400);
  });

  it("auto-approves permission in yolo mode and cancels unknown sessions", async () => {
    const harness = await startHarness();
    await connected(harness);
    const detail = await createTask(harness, { yolo: true });
    harness.acp.sendRequest(502, "session/request_permission", {
      sessionId: detail.id,
      toolCall: { toolCallId: "t1", title: "Run ls" },
      options: [
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "once", name: "Once", kind: "allow_once" },
      ],
    });
    const reply = await harness.acp.waitForFrame(
      (frame) => frame["id"] === 502,
      "the auto approval",
    );
    expect(reply["result"]).toEqual({ outcome: { outcome: "selected", optionId: "once" } });

    harness.acp.sendRequest(503, "session/request_permission", {
      sessionId: "missing",
      toolCall: { toolCallId: "t1", title: "Run ls" },
      options: [{ optionId: "once", name: "Once", kind: "allow_once" }],
    });
    const cancelled = await harness.acp.waitForFrame(
      (frame) => frame["id"] === 503,
      "the unknown session reply",
    );
    expect(cancelled["result"]).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("cancels a permission request after the timeout", async () => {
    const harness = await startHarness({ env: { GROK_WEB_PERMISSION_TIMEOUT_MS: "60" } });
    await connected(harness);
    const detail = await createTask(harness);
    harness.acp.sendRequest(504, "session/request_permission", {
      sessionId: detail.id,
      toolCall: { toolCallId: "t1", title: "Run ls" },
      options: [{ optionId: "once", name: "Once", kind: "allow_once" }],
    });
    const reply = await harness.acp.waitForFrame(
      (frame) => frame["id"] === 504,
      "the timeout reply",
    );
    expect(reply["result"]).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("validates settings updates", async () => {
    const harness = await startHarness();
    await connected(harness);
    const invalid = await call(harness.handler, "PUT", "/api/settings", { url: "http://nope" });
    expect(invalid.status).toBe(400);
    const root = await call(harness.handler, "PUT", "/api/settings", { defaultCwd: "/" });
    expect(root.status).toBe(400);
    const badBody = await call(harness.handler, "PUT", "/api/settings", ["not", "an", "object"]);
    expect(badBody.status).toBe(400);

    const updated = await call(harness.handler, "PUT", "/api/settings", {
      secret: "new-secret",
      defaultModel: "model-x",
    });
    expect(await json(updated)).toMatchObject({ hasSecret: true, defaultModel: "model-x" });
  });
});
