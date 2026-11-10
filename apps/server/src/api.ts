import type { InitializeResult } from "@grok-build-web/acp-protocol";
import { asRecord, asString, emptyResponse, readFileResponse } from "@grok-build-web/acp-protocol";
import { AcpClient, AcpError, initialize, type IncomingRequest } from "@grok-build-web/acp-client";
import { toDetail, type Task } from "@grok-build-web/task-model";
import { Effect, Layer, Ref, Scope, Stream } from "effect";
import { HttpRouter, HttpServerResponse, type HttpServerRequest } from "effect/http";
import { chatSse, sseFrame } from "./chat.ts";
import { redactUrl, type ServerConfig } from "./config.ts";
import { FsBridge } from "./fs-bridge.ts";
import {
  listDirectories,
  reachableRoots,
  resolveDirectory,
  resolveTaskCwd,
  resolveTerminalCwd,
} from "./paths.ts";
import { ProjectRegistry } from "./projects.ts";
import { checkRequest, readJsonBody, requestGuardPolicy } from "./security.ts";
import { TaskRegistry } from "./tasks.ts";
import { TerminalRegistry } from "./terminal.ts";

// Bounded fan-out: a parked wait_for_exit must not serialize the queue, but the queue must stay finite.
const REQUEST_CONCURRENCY = 32;

type Response = HttpServerResponse.HttpServerResponse;
type Handler = (
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<Response, never, HttpRouter.RouteContext>;

const json = (body: unknown, status = 200): Response =>
  HttpServerResponse.jsonUnsafe(body, { status });

const settingsPayload = (config: ServerConfig): unknown => ({
  url: redactUrl(config.acpUrl),
  hasSecret: config.acpSecret !== undefined,
  defaultCwd: config.defaultCwd,
  roots: reachableRoots(config),
  defaultModel: config.defaultModel,
  readOnly: config.readOnly,
  configFile: config.configFile,
  configFileExists: config.configFileExists,
});

export const requestHandler = (
  incoming: IncomingRequest,
  config: ServerConfig,
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
          Effect.gen(function* () {
            const task = yield* session();
            const requested = request.cwd ?? task.cwd;
            const cwd = yield* resolveTerminalCwd(requested, task.cwd, config.allowedRoots);
            if (cwd === undefined) {
              return yield* new AcpError({
                message: `Working directory is outside the allowed roots: ${requested}`,
              });
            }
            return yield* terminals.create(task.id, {
              command: request.command,
              args: request.args,
              env: request.env,
              cwd,
            });
          }),
          (terminalId) => ({ terminalId }),
        );
      case "terminal_output":
        return yield* reply(
          Effect.flatMap(session(), () =>
            Effect.gen(function* () {
              const terminal = yield* terminals.get(request.sessionId, request.terminalId);
              if (terminal === undefined) {
                return yield* new AcpError({ message: `Unknown terminal: ${request.terminalId}` });
              }
              const output = terminal.read();
              if (output.error !== undefined) {
                return yield* new AcpError({ message: output.error });
              }
              return output;
            }),
          ),
          (output) => output,
        );
      case "terminal_wait_for_exit":
        return yield* reply(
          Effect.flatMap(session(), () =>
            Effect.gen(function* () {
              const terminal = yield* terminals.get(request.sessionId, request.terminalId);
              if (terminal === undefined) {
                return yield* new AcpError({ message: `Unknown terminal: ${request.terminalId}` });
              }
              return yield* Effect.tryPromise({
                try: () => terminal.waitForExit(),
                catch: (cause) => new AcpError({ message: String(cause) }),
              });
            }),
          ),
          (exitStatus) => exitStatus,
        );
      case "terminal_kill":
        yield* terminals.kill(request.sessionId, request.terminalId);
        return yield* incoming.reply(emptyResponse());
      case "terminal_release":
        yield* terminals.release(request.sessionId, request.terminalId);
        return yield* incoming.reply(emptyResponse());
    }
  });

export const startRequestHandler = (
  config: ServerConfig,
): Effect.Effect<
  void,
  never,
  AcpClient | FsBridge | TerminalRegistry | TaskRegistry | Scope.Scope
> =>
  Effect.gen(function* () {
    const client = yield* AcpClient;
    yield* Effect.forkScoped(
      client.incomingRequests.pipe(
        Stream.mapEffect(
          (incoming) => requestHandler(incoming, config).pipe(Effect.catchCause(() => Effect.void)),
          { concurrency: REQUEST_CONCURRENCY },
        ),
        Stream.runDrain,
      ),
    );
  });

export const routes = (
  config: ServerConfig,
): Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | AcpClient | TaskRegistry | ProjectRegistry | FsBridge | TerminalRegistry
> => {
  const policy = requestGuardPolicy(config);
  return HttpRouter.use((router) =>
    Effect.gen(function* () {
      const client = yield* AcpClient;
      const registry = yield* TaskRegistry;
      const projectRegistry = yield* ProjectRegistry;
      const agentRef = yield* Ref.make<InitializeResult | undefined>(undefined);
      const sseClients = yield* Ref.make(0);

      const refreshAgent = initialize(client).pipe(
        Effect.flatMap((result) => Ref.set(agentRef, result)),
        Effect.ignore,
      );

      // Subscribe before the first attempt so a connection that becomes ready early is not missed.
      yield* Effect.forkScoped(
        client.statusChanges.pipe(
          Stream.runForEach((status) =>
            status.state === "connected" ? refreshAgent : Effect.void,
          ),
        ),
      );
      yield* refreshAgent;

      const guarded =
        (handler: Handler): Handler =>
        (request) =>
          Effect.suspend(() => {
            const decision = checkRequest(request.headers, policy);
            return decision === undefined
              ? handler(request)
              : Effect.succeed(json({ error: decision.message }, decision.status));
          });

      const bodyOf = (request: HttpServerRequest.HttpServerRequest) =>
        readJsonBody(request, config.maxBodyBytes);

      const respond = <A>(
        effect: Effect.Effect<A, AcpError>,
        toBody: (value: A) => unknown = (value) => value,
      ): Effect.Effect<Response> =>
        effect.pipe(
          Effect.map((value) => json(toBody(value))),
          Effect.catchTag("AcpError", (error) =>
            Effect.succeed(json({ error: error.message }, 400)),
          ),
        );

      const readOnlyResponse = (): Response | undefined =>
        config.readOnly
          ? json({ error: "Read-only mode: tasks cannot be created or prompted" }, 403)
          : undefined;

      const taskId = Effect.map(HttpRouter.params, (params) => params["id"] ?? "");

      const openSseSlot = Ref.modify(sseClients, (open) =>
        open < config.maxSseClients ? [true, open + 1] : [false, open],
      );
      const releaseSseSlot = Ref.update(sseClients, (open) => Math.max(0, open - 1));
      const tooManyStreams = json({ error: "Too many open event streams" }, 429);

      yield* router.add(
        "GET",
        "/api/health",
        guarded(() =>
          Effect.gen(function* () {
            const status = yield* client.status;
            return json({
              ok: true,
              acp: {
                connected: status.state === "connected",
                url: redactUrl(config.acpUrl),
                lastError: status.lastError,
              },
            });
          }),
        ),
      );

      yield* router.add(
        "GET",
        "/api/settings",
        guarded(() => Effect.succeed(json(settingsPayload(config)))),
      );

      yield* router.add(
        "GET",
        "/api/agent",
        guarded(() =>
          Effect.gen(function* () {
            const status = yield* client.status;
            const info = yield* Ref.get(agentRef);
            return json({
              connected: status.state === "connected",
              models: info?.modelState ?? { availableModels: [] },
              availableCommands: info?.availableCommands ?? [],
              capabilities: info?.agentCapabilities ?? {},
            });
          }),
        ),
      );

      yield* router.add(
        "GET",
        "/api/projects",
        guarded(() =>
          Effect.gen(function* () {
            return json({ projects: yield* projectRegistry.list });
          }),
        ),
      );

      yield* router.add(
        "POST",
        "/api/projects",
        guarded((request) =>
          Effect.gen(function* () {
            const body = yield* bodyOf(request);
            if (!body.ok) return json({ error: body.message }, body.status);
            const record = asRecord(body.value) ?? {};
            const requested = asString(record["root"]);
            if (requested === undefined) return json({ error: "Expected a project root" }, 400);
            const root = yield* resolveDirectory(requested, config);
            if (root === undefined) {
              return json(
                {
                  error: `Project root is outside the allowed roots or not a directory: ${requested}`,
                },
                400,
              );
            }
            const result = yield* projectRegistry.create({
              name: asString(record["name"]),
              root,
            });
            return result.ok ? json(result.project) : json({ error: result.message }, 400);
          }),
        ),
      );

      yield* router.add(
        "GET",
        "/api/fs/dirs",
        guarded((request) =>
          Effect.gen(function* () {
            const requested = new URL(request.url, "http://localhost").searchParams.get("path");
            const path = requested === null || requested === "" ? config.defaultCwd : requested;
            const listing = yield* listDirectories(path, config);
            return listing === undefined
              ? json(
                  { error: `Directory is outside the allowed roots or unreadable: ${path}` },
                  400,
                )
              : json(listing);
          }),
        ),
      );

      yield* router.add(
        "GET",
        "/api/tasks",
        guarded(() =>
          Effect.gen(function* () {
            return json({ tasks: yield* registry.list });
          }),
        ),
      );

      yield* router.add(
        "POST",
        "/api/tasks",
        guarded((request) =>
          Effect.gen(function* () {
            const denied = readOnlyResponse();
            if (denied !== undefined) return denied;
            const body = yield* bodyOf(request);
            if (!body.ok) return json({ error: body.message }, body.status);
            const record = asRecord(body.value) ?? {};
            const requested = asString(record["cwd"]);
            const requestedCwd =
              requested === undefined || requested === "" ? config.defaultCwd : requested;
            const cwd = yield* resolveTaskCwd(requestedCwd, config);
            if (cwd === undefined) {
              return json(
                { error: `Working directory is outside the allowed roots: ${requestedCwd}` },
                400,
              );
            }
            return yield* respond(
              registry.create({
                cwd,
                prompt: asString(record["prompt"]),
                model: asString(record["model"]) ?? config.defaultModel,
                yolo: record["yolo"] === true,
              }),
              toDetail,
            );
          }),
        ),
      );

      yield* router.add(
        "GET",
        "/api/tasks/:id",
        guarded(() =>
          Effect.gen(function* () {
            const id = yield* taskId;
            const task = yield* registry.get(id);
            return task === undefined
              ? json({ error: "Task not found" }, 404)
              : json(toDetail(task));
          }),
        ),
      );

      yield* router.add(
        "POST",
        "/api/tasks/:id/prompt",
        guarded((request) =>
          Effect.gen(function* () {
            const denied = readOnlyResponse();
            if (denied !== undefined) return denied;
            const id = yield* taskId;
            const body = yield* bodyOf(request);
            if (!body.ok) return json({ error: body.message }, body.status);
            const record = asRecord(body.value) ?? {};
            const text = asString(record["text"]) ?? "";
            return yield* respond(registry.prompt(id, text).pipe(Effect.as({ accepted: true })));
          }),
        ),
      );

      yield* router.add(
        "POST",
        "/api/tasks/:id/cancel",
        guarded(() =>
          Effect.gen(function* () {
            const id = yield* taskId;
            return yield* respond(registry.cancel(id).pipe(Effect.as({ accepted: true })));
          }),
        ),
      );

      yield* router.add(
        "POST",
        "/api/tasks/:id/close",
        guarded(() =>
          Effect.gen(function* () {
            const id = yield* taskId;
            const task = yield* registry.get(id);
            if (task === undefined) return json({ error: "Task not found" }, 404);
            return yield* respond(registry.close(id).pipe(Effect.as({ closed: true })));
          }),
        ),
      );

      yield* router.add(
        "POST",
        "/api/tasks/:id/permission",
        guarded((request) =>
          Effect.gen(function* () {
            const id = yield* taskId;
            const body = yield* bodyOf(request);
            if (!body.ok) return json({ error: body.message }, body.status);
            const record = asRecord(body.value) ?? {};
            const requestId = asString(record["requestId"]) ?? "";
            const optionId = asString(record["optionId"]);
            const decision =
              record["decision"] === "cancel"
                ? ("cancel" as const)
                : optionId === undefined
                  ? undefined
                  : { optionId };
            if (decision === undefined)
              return json({ error: "Expected optionId or decision" }, 400);
            return yield* respond(
              registry
                .respondPermission(id, requestId, decision)
                .pipe(Effect.as({ accepted: true })),
            );
          }),
        ),
      );

      yield* router.add(
        "POST",
        "/api/tasks/:id/chat",
        guarded((request) =>
          Effect.gen(function* () {
            const denied = readOnlyResponse();
            if (denied !== undefined) return denied;
            const id = yield* taskId;
            const task = yield* registry.get(id);
            if (task === undefined) return json({ error: "Task not found" }, 404);
            const body = yield* bodyOf(request);
            if (!body.ok) return json({ error: body.message }, body.status);
            if (!(yield* openSseSlot)) return tooManyStreams;
            const record = asRecord(body.value) ?? {};
            const stream = Stream.unwrap(
              chatSse(
                id,
                {
                  threadId: asString(record["threadId"]) ?? id,
                  runId: asString(record["runId"]) ?? `run-${Date.now()}`,
                  text: lastUserText(body.value),
                },
                client,
                registry,
              ),
            ).pipe(Stream.ensuring(releaseSseSlot));
            return HttpServerResponse.stream(stream, {
              contentType: "text/event-stream",
              headers: { "cache-control": "no-cache" },
            });
          }),
        ),
      );

      yield* router.add(
        "GET",
        "/api/events",
        guarded(() =>
          Effect.gen(function* () {
            if (!(yield* openSseSlot)) return tooManyStreams;
            const initial = yield* registry.list;
            const updates = registry.changes.pipe(
              Stream.map((tasks) => sseFrame({ type: "tasks", tasks })),
            );
            const heartbeats = Stream.tick(config.eventsHeartbeatMs).pipe(
              Stream.map(() => sseFrame({ type: "heartbeat" })),
            );
            return HttpServerResponse.stream(
              Stream.concat(
                Stream.make(sseFrame({ type: "tasks", tasks: initial })),
                Stream.merge(updates, heartbeats),
              ).pipe(Stream.ensuring(releaseSseSlot)),
              { contentType: "text/event-stream", headers: { "cache-control": "no-cache" } },
            );
          }),
        ),
      );
    }),
  );
};

const lastUserText = (body: unknown): string => {
  const messages = asRecord(body)?.["messages"];
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = asRecord(list[index]);
    if (message === undefined || message["role"] !== "user") continue;
    const content = message["content"];
    const direct = asString(content);
    if (direct !== undefined) return direct;
    const parts = Array.isArray(content) ? content : [];
    return parts
      .map((part) => {
        const record = asRecord(part);
        return asString(record?.["text"] ?? record?.["content"]) ?? "";
      })
      .join("");
  }
  return "";
};
