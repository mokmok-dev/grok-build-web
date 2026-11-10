import type { InitializeResult, QueueEntry, PlanEntry } from "@grok-build-web/acp-protocol";
import {
  asArray,
  asRecord,
  asString,
  terminalOutputResponse,
  emptyResponse,
  readFileResponse,
} from "@grok-build-web/acp-protocol";
import { AcpClient, AcpError, initialize, type IncomingRequest } from "@grok-build-web/acp-client";
import {
  type PendingPermission,
  type ChatMessage,
  type Task,
  type TaskSummary,
} from "@grok-build-web/task-model";
import { Effect, Layer, Ref, Scope, Stream } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerResponse,
  type HttpServerRequest,
} from "effect/http";
import * as Schema from "effect/Schema";
import { chatSse, sseFrame } from "./chat.ts";
import { redactUrl, Settings } from "./config.ts";
import { FsBridge } from "./fs-bridge.ts";
import { TaskRegistry } from "./tasks.ts";
import { TerminalRegistry } from "./terminal.ts";

export interface TaskDetail extends TaskSummary {
  readonly messages: readonly ChatMessage[];
  readonly plan: readonly PlanEntry[];
  readonly availableCommands: readonly unknown[];
  readonly configOptions: readonly unknown[];
  readonly pendingPermission?: PendingPermission;
  readonly queue: readonly QueueEntry[];
}

export const toDetail = (task: Task): TaskDetail => ({
  id: task.id,
  title: task.title,
  cwd: task.cwd,
  model: task.model,
  status: task.status,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  messageCount: task.messages.length,
  pendingPermission: task.pendingPermission,
  usage: task.usage,
  lastError: task.lastError,
  messages: task.messages,
  plan: task.plan,
  availableCommands: task.availableCommands,
  configOptions: task.configOptions,
  queue: task.queue,
});

const notFound = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe({ error: "Task not found" }, { status: 404 });

const badRequest = (message: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status: 400 });

const respond = <A>(
  effect: Effect.Effect<A, AcpError>,
  toResponse: (value: A) => HttpServerResponse.HttpServerResponse,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  effect.pipe(
    Effect.map(toResponse),
    Effect.catchTag("AcpError", (error) => Effect.succeed(badRequest(error.message))),
  );

const lastUserText = (body: unknown): string => {
  const messages = asArray(asRecord(body)?.["messages"]) ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message === undefined || message["role"] !== "user") continue;
    const content = message["content"];
    const direct = asString(content);
    if (direct !== undefined) return direct;
    const parts = asArray(content) ?? [];
    return parts
      .map((part) => {
        const record = asRecord(part);
        return asString(record?.["text"] ?? record?.["content"]) ?? "";
      })
      .join("");
  }
  return "";
};

const jsonBody = (request: HttpServerRequest.HttpServerRequest) =>
  HttpIncomingMessage.schemaBodyJson(Schema.Unknown)(request);

export const requestHandler = (
  incoming: IncomingRequest,
): Effect.Effect<void, never, FsBridge | TerminalRegistry | TaskRegistry> =>
  Effect.gen(function* () {
    const fs = yield* FsBridge;
    const terminals = yield* TerminalRegistry;
    const registry = yield* TaskRegistry;
    const request = incoming.request;

    const reply = <A>(
      effect: Effect.Effect<A, AcpError>,
      toResult: (value: A) => unknown,
    ): Effect.Effect<void> =>
      effect.pipe(
        Effect.matchEffect({
          onFailure: (error) => incoming.fail(-32000, error.message),
          onSuccess: (value) => incoming.reply(toResult(value)),
        }),
      );

    const session = (): Effect.Effect<Task, AcpError> =>
      Effect.gen(function* () {
        const task = yield* registry.get(request.sessionId);
        if (task === undefined) {
          return yield* new AcpError({ message: `Unknown session: ${request.sessionId}` });
        }
        return task;
      });

    switch (request.kind) {
      case "request_permission":
        return;
      case "fs_read":
        return yield* reply(
          Effect.flatMap(session(), (task) =>
            fs.read(task.cwd, request.path, request.line, request.limit),
          ),
          readFileResponse,
        );
      case "fs_write":
        return yield* reply(
          Effect.flatMap(session(), (task) => fs.write(task.cwd, request.path, request.content)),
          emptyResponse,
        );
      case "terminal_create":
        return yield* reply(
          Effect.flatMap(session(), (task) =>
            terminals.create({
              command: request.command,
              args: request.args,
              env: request.env,
              cwd: request.cwd ?? task.cwd,
            }),
          ),
          (terminalId) => ({ terminalId }),
        );
      case "terminal_output":
        return yield* reply(
          Effect.flatMap(terminals.get(request.terminalId), (terminal) =>
            terminal === undefined
              ? Effect.fail(new AcpError({ message: `Unknown terminal: ${request.terminalId}` }))
              : Effect.sync(() => terminal.read()),
          ),
          (output) => terminalOutputResponse(output.output, output.truncated, output.exitStatus),
        );
      case "terminal_wait_for_exit":
        return yield* reply(
          Effect.flatMap(terminals.get(request.terminalId), (terminal) =>
            terminal === undefined
              ? Effect.fail(new AcpError({ message: `Unknown terminal: ${request.terminalId}` }))
              : Effect.promise(() => terminal.waitForExit()),
          ),
          (exitStatus) => exitStatus,
        );
      case "terminal_kill":
        yield* terminals.kill(request.terminalId);
        return yield* incoming.reply(emptyResponse());
      case "terminal_release":
        yield* terminals.release(request.terminalId);
        return yield* incoming.reply(emptyResponse());
    }
  });

export const startRequestHandler: Effect.Effect<
  void,
  never,
  AcpClient | FsBridge | TerminalRegistry | TaskRegistry | Scope.Scope
> = Effect.gen(function* () {
  const client = yield* AcpClient;
  yield* Effect.forkScoped(
    client.incomingRequests.pipe(Stream.runForEach((incoming) => requestHandler(incoming))),
  );
});

export const routes: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | AcpClient | Settings | TaskRegistry | FsBridge | TerminalRegistry
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const client = yield* AcpClient;
    const settings = yield* Settings;
    const registry = yield* TaskRegistry;
    const agentRef = yield* Ref.make<InitializeResult | undefined>(undefined);

    const refreshAgent = initialize(client).pipe(
      Effect.flatMap((result) => Ref.set(agentRef, result)),
      Effect.ignore,
    );

    yield* refreshAgent;
    yield* Effect.forkScoped(
      client.statusChanges.pipe(
        Stream.runForEach((status) => (status.state === "connected" ? refreshAgent : Effect.void)),
      ),
    );

    const taskId = Effect.map(HttpRouter.params, (params) => params["id"] ?? "");

    yield* router.add("GET", "/api/health", () =>
      Effect.gen(function* () {
        const status = yield* client.status;
        const current = yield* settings.get;
        return HttpServerResponse.jsonUnsafe({
          ok: true,
          acp: {
            connected: status.state === "connected",
            url: redactUrl(current.url),
            lastError: status.lastError,
          },
        });
      }),
    );

    yield* router.add("GET", "/api/settings", () =>
      Effect.gen(function* () {
        const current = yield* settings.get;
        return HttpServerResponse.jsonUnsafe({
          url: redactUrl(current.url),
          hasSecret: current.secret !== undefined,
          defaultCwd: current.defaultCwd,
          defaultModel: current.defaultModel,
          readOnly: current.readOnly,
        });
      }),
    );

    yield* router.add("PUT", "/api/settings", (request) =>
      Effect.gen(function* () {
        const body = asRecord(yield* jsonBody(request));
        if (body === undefined) return badRequest("Expected a JSON object");
        const current = yield* settings.update({
          url: asString(body["url"]),
          secret: asString(body["secret"]),
          defaultCwd: asString(body["defaultCwd"]),
          defaultModel: asString(body["defaultModel"]),
        });
        return HttpServerResponse.jsonUnsafe({
          url: redactUrl(current.url),
          hasSecret: current.secret !== undefined,
          defaultCwd: current.defaultCwd,
          defaultModel: current.defaultModel,
          readOnly: current.readOnly,
        });
      }).pipe(Effect.orDie),
    );

    yield* router.add("GET", "/api/agent", () =>
      Effect.gen(function* () {
        const status = yield* client.status;
        const info = yield* Ref.get(agentRef);
        return HttpServerResponse.jsonUnsafe({
          connected: status.state === "connected",
          models: info?.modelState ?? { availableModels: [] },
          availableCommands: info?.availableCommands ?? [],
          capabilities: info?.agentCapabilities ?? {},
        });
      }),
    );

    yield* router.add("GET", "/api/tasks", () =>
      Effect.gen(function* () {
        const tasks = yield* registry.list;
        return HttpServerResponse.jsonUnsafe({ tasks });
      }),
    );

    yield* router.add("POST", "/api/tasks", (request) =>
      Effect.gen(function* () {
        const body = asRecord(yield* jsonBody(request)) ?? {};
        const current = yield* settings.get;
        const cwd = asString(body["cwd"]) ?? current.defaultCwd;
        return yield* respond(
          registry.create({
            cwd,
            prompt: asString(body["prompt"]),
            model: asString(body["model"]) ?? current.defaultModel,
            yolo: body["yolo"] === true,
          }),
          (task) => HttpServerResponse.jsonUnsafe(toDetail(task)),
        );
      }).pipe(Effect.orDie),
    );

    yield* router.add("GET", "/api/tasks/:id", () =>
      Effect.gen(function* () {
        const id = yield* taskId;
        const task = yield* registry
          .hydrate(id)
          .pipe(Effect.catchTag("AcpError", () => Effect.succeed(undefined)));
        return task === undefined ? notFound() : HttpServerResponse.jsonUnsafe(toDetail(task));
      }),
    );

    yield* router.add("POST", "/api/tasks/:id/prompt", (request) =>
      Effect.gen(function* () {
        const id = yield* taskId;
        const body = asRecord(yield* jsonBody(request)) ?? {};
        const text = asString(body["text"]) ?? "";
        return yield* respond(
          registry.prompt(id, text).pipe(Effect.as({ accepted: true })),
          (value) => HttpServerResponse.jsonUnsafe(value),
        );
      }).pipe(Effect.orDie),
    );

    yield* router.add("POST", "/api/tasks/:id/cancel", () =>
      Effect.gen(function* () {
        const id = yield* taskId;
        return yield* respond(registry.cancel(id).pipe(Effect.as({ accepted: true })), (value) =>
          HttpServerResponse.jsonUnsafe(value),
        );
      }),
    );

    yield* router.add("POST", "/api/tasks/:id/close", () =>
      Effect.gen(function* () {
        const id = yield* taskId;
        const task = yield* registry.get(id);
        if (task === undefined) return notFound();
        return yield* respond(registry.close(id).pipe(Effect.as({ closed: true })), (value) =>
          HttpServerResponse.jsonUnsafe(value),
        );
      }),
    );

    yield* router.add("POST", "/api/tasks/:id/permission", (request) =>
      Effect.gen(function* () {
        const id = yield* taskId;
        const body = asRecord(yield* jsonBody(request)) ?? {};
        const requestId = asString(body["requestId"]) ?? "";
        const optionId = asString(body["optionId"]);
        const decision =
          body["decision"] === "cancel"
            ? ("cancel" as const)
            : optionId === undefined
              ? undefined
              : { optionId };
        if (decision === undefined) return badRequest("Expected optionId or decision");
        return yield* respond(
          registry.respondPermission(id, requestId, decision).pipe(Effect.as({ accepted: true })),
          (value) => HttpServerResponse.jsonUnsafe(value),
        );
      }).pipe(Effect.orDie),
    );

    yield* router.add("POST", "/api/tasks/:id/chat", (request) =>
      Effect.gen(function* () {
        const id = yield* taskId;
        const task = yield* registry.get(id);
        if (task === undefined) return notFound();
        const body = asRecord(yield* jsonBody(request)) ?? {};
        const stream = Stream.unwrap(
          chatSse(
            id,
            {
              threadId: asString(body["threadId"]) ?? id,
              runId: asString(body["runId"]) ?? `run-${Date.now()}`,
              text: lastUserText(body),
            },
            client,
            registry,
          ),
        );
        return HttpServerResponse.stream(stream, {
          contentType: "text/event-stream",
          headers: { "cache-control": "no-cache" },
        });
      }).pipe(Effect.orDie),
    );

    yield* router.add("GET", "/api/events", () =>
      Effect.gen(function* () {
        const initial = yield* registry.list;
        const updates = registry.changes.pipe(
          Stream.map((tasks) => sseFrame({ type: "tasks", tasks })),
        );
        const heartbeats = Stream.tick("15 seconds").pipe(
          Stream.map(() => sseFrame({ type: "heartbeat" })),
        );
        return HttpServerResponse.stream(
          Stream.concat(
            Stream.make(sseFrame({ type: "tasks", tasks: initial })),
            Stream.merge(updates, heartbeats),
          ),
          {
            contentType: "text/event-stream",
            headers: { "cache-control": "no-cache" },
          },
        );
      }),
    );
  }),
);
