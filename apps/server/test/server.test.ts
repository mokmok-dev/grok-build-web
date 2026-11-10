import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { HttpRouter } from "effect/http";
import { appLayer } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

interface FakeAcp {
  readonly url: string;
  readonly methods: string[];
  readonly close: () => Promise<void>;
  readonly prompts: string[];
}

const startFakeAcp = async (): Promise<FakeAcp> => {
  const wss = new WebSocketServer({ port: 0 });
  const methods: string[] = [];
  const prompts: string[] = [];
  const sockets: WebSocket[] = [];
  let sessions = 0;

  const reply = (socket: WebSocket, id: unknown, result: unknown): void => {
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  };
  const notify = (socket: WebSocket, method: string, params: unknown): void => {
    socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  };

  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as {
        id?: unknown;
        method?: string;
        params?: Record<string, unknown>;
      };
      methods.push(message.method ?? "");
      switch (message.method) {
        case "initialize":
          reply(socket, message.id, {
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
          reply(socket, message.id, {
            sessionId,
            models: { currentModelId: "test-model", availableModels: [{ modelId: "test-model" }] },
            configOptions: [{ id: "model" }],
          });
          return;
        }
        case "session/prompt": {
          const params = message.params ?? {};
          const sessionId = String(params["sessionId"]);
          const prompt = params["prompt"] as Array<{ text?: string }> | undefined;
          prompts.push(prompt?.[0]?.text ?? "");
          setTimeout(() => {
            notify(socket, "session/update", {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "pong" },
                messageId: "m1",
              },
            });
            notify(socket, "_x.ai/session_notification", {
              sessionId,
              update: { sessionUpdate: "turn_completed", usage: { totalTokens: 3 } },
            });
            notify(socket, "_x.ai/session/prompt_complete", { sessionId, promptId: "p" });
            reply(socket, message.id, { stopReason: "end_turn", usage: { totalTokens: 3 } });
          }, 100);
          return;
        }
        case "session/cancel":
        case "session/close":
        case "session/load":
        case "session/set_config_option":
          reply(socket, message.id, {});
          return;
        default:
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "unknown method" },
            }),
          );
      }
    });
  });

  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    methods,
    prompts,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.terminate();
        wss.close(() => resolve());
      }),
  };
};

type Handler = (request: Request) => Promise<Response>;

const call = async (
  handler: Handler,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> =>
  handler(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
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

const startHarness = async (): Promise<Harness> => {
  const acp = await startFakeAcp();
  const cwd = await mkdtemp(join(tmpdir(), "grok-web-server-"));
  const config = loadConfig({
    GROK_ACP_URL: acp.url,
    GROK_ACP_SECRET: "testsecret",
    GROK_WEB_DEFAULT_CWD: cwd,
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
    const health = await json<{ acp: { connected: boolean } }>(
      await call(harness.handler, "GET", "/api/health"),
    );
    return health.acp.connected ? true : undefined;
  });

const readSse = async (response: Response, until: (text: string) => boolean): Promise<string> => {
  const body = response.body;
  if (body === null) throw new Error("no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!until(text)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel();
  return text;
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
      messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>;
    }>(created);
    expect(detail.status).toBe("running");
    expect(detail.messages[0]).toMatchObject({ role: "user" });

    const tasks = await json<{
      tasks: Array<{ id: string; status: string; messageCount: number }>;
    }>(await call(harness.handler, "GET", "/api/tasks"));
    expect(tasks.tasks.map((task) => task.id)).toContain(detail.id);

    const idle = await waitFor(async () => {
      const current = await json<{
        status: string;
        messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>;
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

  it("sends follow-up prompts and cancels", async () => {
    const harness = await startHarness();
    await connected(harness);
    const detail = await json<{ id: string }>(
      await call(harness.handler, "POST", "/api/tasks", {}),
    );

    const accepted = await call(harness.handler, "POST", `/api/tasks/${detail.id}/prompt`, {
      text: "again",
    });
    expect(await json(accepted)).toEqual({ accepted: true });
    await waitFor(async () => {
      const current = await json<{ status: string }>(
        await call(harness.handler, "GET", `/api/tasks/${detail.id}`),
      );
      return current.status === "idle" ? true : undefined;
    });

    const cancel = await call(harness.handler, "POST", `/api/tasks/${detail.id}/cancel`, {});
    expect(await json(cancel)).toEqual({ accepted: true });
    await waitFor(async () => (harness.acp.methods.includes("session/cancel") ? true : undefined));
    expect(harness.acp.prompts).toEqual(["again"]);
  });

  it("streams an AG-UI turn over SSE", async () => {
    const harness = await startHarness();
    await connected(harness);
    const detail = await json<{ id: string }>(
      await call(harness.handler, "POST", "/api/tasks", {}),
    );

    const response = await call(harness.handler, "POST", `/api/tasks/${detail.id}/chat`, {
      threadId: detail.id,
      runId: "run-1",
      messages: [{ id: "m1", role: "user", content: "Reply with the single word: pong" }],
      tools: [],
      context: [],
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await readSse(response, (text) => text.includes("RUN_FINISHED"));
    expect(body).toContain("RUN_STARTED");
    expect(body).toContain("TEXT_MESSAGE_CONTENT");
    expect(body).toContain("pong");
    expect(body).toContain("RUN_FINISHED");
  });

  it("streams the task list over SSE", async () => {
    const harness = await startHarness();
    await connected(harness);
    await call(harness.handler, "POST", "/api/tasks", {});
    const response = await call(harness.handler, "GET", "/api/events");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await readSse(response, (text) => text.includes('"type":"tasks"'));
    expect(body).toContain('"type":"tasks"');
  });

  it("returns 404 for unknown tasks and rejects unknown permissions", async () => {
    const harness = await startHarness();
    await connected(harness);
    const missing = await call(harness.handler, "GET", "/api/tasks/nope");
    expect(missing.status).toBe(404);
    const detail = await json<{ id: string }>(
      await call(harness.handler, "POST", "/api/tasks", {}),
    );
    const permission = await call(harness.handler, "POST", `/api/tasks/${detail.id}/permission`, {
      requestId: "missing",
      optionId: "allow_once",
    });
    expect(permission.status).toBe(400);
    const badBody = await call(harness.handler, "POST", `/api/tasks/${detail.id}/permission`, {
      requestId: "missing",
    });
    expect(badBody.status).toBe(400);
  });

  it("serves the agent capabilities", async () => {
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
  });
});
