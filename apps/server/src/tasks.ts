import type { PromptResult, ServerNotification } from "@grok-build-web/acp-protocol";
import {
  parsePromptResult,
  parseSessionNewResult,
  permissionCancelled,
  permissionSelected,
} from "@grok-build-web/acp-protocol";
import {
  AcpClient,
  AcpError,
  autoSelectOption,
  type IncomingRequest,
} from "@grok-build-web/acp-client";
import {
  appendUserMessage,
  applyNotification,
  applySessionChange,
  createTask,
  markClosed,
  markError,
  markHydrated,
  markReady,
  resolvePermission,
  setPendingPermission,
  toSummary,
  type Task,
  type TaskSummary,
} from "@grok-build-web/task-model";
import { Context, Effect, Layer, PubSub, Ref, Scope, Stream } from "effect";

export interface CreateTaskInput {
  readonly cwd: string;
  readonly prompt?: string;
  readonly model?: string;
  readonly yolo: boolean;
}

export interface TaskRegistryShape {
  readonly list: Effect.Effect<readonly TaskSummary[]>;
  readonly changes: Stream.Stream<readonly TaskSummary[]>;
  readonly get: (id: string) => Effect.Effect<Task | undefined>;
  readonly create: (input: CreateTaskInput) => Effect.Effect<Task, AcpError>;
  readonly hydrate: (id: string) => Effect.Effect<Task | undefined, AcpError>;
  readonly prompt: (id: string, text: string) => Effect.Effect<void, AcpError>;
  readonly promptAndWait: (id: string, text: string) => Effect.Effect<PromptResult, AcpError>;
  readonly cancel: (id: string) => Effect.Effect<void, AcpError>;
  readonly close: (id: string) => Effect.Effect<void, AcpError>;
  readonly respondPermission: (
    id: string,
    requestId: string,
    decision: { readonly optionId: string } | "cancel",
  ) => Effect.Effect<void, AcpError>;
}

export class TaskRegistry extends Context.Service<TaskRegistry, TaskRegistryShape>()(
  "@grok-build-web/server/TaskRegistry",
) {}

interface PendingPermissionEntry {
  readonly taskId: string;
  readonly incoming: IncomingRequest;
}

const permissionTimeout = "5 minutes";

const now = (): number => Date.now();

export const makeTaskRegistry: Effect.Effect<TaskRegistryShape, never, AcpClient | Scope.Scope> =
  Effect.gen(function* () {
    const client = yield* AcpClient;
    const tasksRef = yield* Ref.make<ReadonlyMap<string, Task>>(new Map());
    const yoloRef = yield* Ref.make<ReadonlySet<string>>(new Set());
    const pendingRef = yield* Ref.make<ReadonlyMap<string, PendingPermissionEntry>>(new Map());
    const changesPub = yield* PubSub.unbounded<readonly TaskSummary[]>();

    const summarize = (tasks: ReadonlyMap<string, Task>): readonly TaskSummary[] =>
      [...tasks.values()].sort((left, right) => right.updatedAt - left.updatedAt).map(toSummary);

    const publish = Effect.gen(function* () {
      yield* PubSub.publish(changesPub, summarize(yield* Ref.get(tasksRef)));
    });

    const put = (task: Task) =>
      Effect.gen(function* () {
        yield* Ref.update(tasksRef, (tasks) => new Map(tasks).set(task.id, task));
        yield* publish;
      });

    const update = (id: string, change: (task: Task) => Task) =>
      Effect.gen(function* () {
        const task = (yield* Ref.get(tasksRef)).get(id);
        if (task === undefined) return;
        const next = change(task);
        if (next === task) return;
        yield* put(next);
      });

    const handleNotification = (notification: ServerNotification) =>
      Effect.gen(function* () {
        if (notification.kind === "sessions_changed") {
          for (const change of notification.upserted) {
            yield* update(change.sessionId, (task) => applySessionChange(task, change, now()));
          }
          return;
        }
        if (notification.kind === "models_update") return;
        yield* update(notification.sessionId, (task) =>
          applyNotification(task, notification, now()),
        );
      });

    const handlePermission = (incoming: IncomingRequest) =>
      Effect.gen(function* () {
        if (incoming.request.kind !== "request_permission") return;
        const request = incoming.request;
        const task = (yield* Ref.get(tasksRef)).get(request.sessionId);
        if (task === undefined) {
          yield* incoming.reply(permissionCancelled());
          return;
        }
        const auto = autoSelectOption(
          request.options,
          (yield* Ref.get(yoloRef)).has(request.sessionId),
        );
        if (auto !== undefined) {
          yield* incoming.reply(permissionSelected(auto));
          return;
        }
        const requestId = String(incoming.requestId);
        yield* Ref.update(pendingRef, (pending) =>
          new Map(pending).set(requestId, { taskId: task.id, incoming }),
        );
        yield* update(task.id, (current) =>
          setPendingPermission(
            current,
            {
              requestId,
              toolCallId: request.toolCallId,
              title: request.title,
              options: request.options,
            },
            now(),
          ),
        );
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            yield* Effect.sleep(permissionTimeout);
            const pending = yield* Ref.get(pendingRef);
            if (!pending.has(requestId)) return;
            yield* Ref.update(pendingRef, (entries) => {
              const next = new Map(entries);
              next.delete(requestId);
              return next;
            });
            yield* incoming.reply(permissionCancelled());
            yield* update(task.id, (current) => resolvePermission(current, now()));
          }),
        );
      });

    yield* Effect.forkScoped(client.notifications.pipe(Stream.runForEach(handleNotification)));
    yield* Effect.forkScoped(client.incomingRequests.pipe(Stream.runForEach(handlePermission)));
    yield* Effect.forkScoped(
      client.statusChanges.pipe(
        Stream.runForEach((status) =>
          status.state === "error"
            ? Effect.gen(function* () {
                const tasks = yield* Ref.get(tasksRef);
                for (const task of tasks.values()) {
                  if (task.status === "running" || task.status === "awaiting_permission") {
                    yield* update(task.id, (current) =>
                      markError(current, status.lastError ?? "Connection lost", now()),
                    );
                  }
                }
              })
            : Effect.void,
        ),
      ),
    );

    const sendPrompt = (id: string, text: string) =>
      client.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text }] }, 0);

    const appendUser = (id: string, text: string) =>
      update(id, (task) => appendUserMessage(task, text, now()));

    const promptAndWait = (id: string, text: string) =>
      Effect.gen(function* () {
        yield* appendUser(id, text);
        return parsePromptResult(yield* sendPrompt(id, text));
      });

    const prompt = (id: string, text: string) =>
      Effect.gen(function* () {
        yield* appendUser(id, text);
        yield* Effect.forkDetach(
          sendPrompt(id, text).pipe(
            Effect.catchTag("AcpError", (error) =>
              update(id, (task) => markError(task, error.message, now())),
            ),
          ),
        );
      });

    const create = (input: CreateTaskInput) =>
      Effect.gen(function* () {
        const result = yield* client.request("session/new", {
          cwd: input.cwd,
          mcpServers: [],
          _meta: { yoloMode: input.yolo },
        });
        const session = parseSessionNewResult(result);
        if (session === undefined) {
          return yield* new AcpError({ message: "Invalid session/new response" });
        }
        const model = input.model ?? session.models?.currentModelId;
        if (input.model !== undefined) {
          yield* client.request("session/set_config_option", {
            sessionId: session.sessionId,
            configId: "model",
            value: { value: input.model },
          });
        }
        const task = markReady(
          createTask({ id: session.sessionId, cwd: input.cwd, model, now: now() }),
          now(),
        );
        yield* put(task);
        if (input.yolo) {
          yield* Ref.update(yoloRef, (sessions) => new Set(sessions).add(session.sessionId));
        }
        if (input.prompt !== undefined) {
          yield* prompt(session.sessionId, input.prompt);
          return (yield* Ref.get(tasksRef)).get(session.sessionId) ?? task;
        }
        return task;
      });

    const hydrate = (id: string) =>
      Effect.gen(function* () {
        const task = (yield* Ref.get(tasksRef)).get(id);
        if (task === undefined) return undefined;
        if (task.hydrated) return task;
        yield* client.request("session/load", { sessionId: id, cwd: task.cwd, mcpServers: [] });
        // Replayed updates arrive on the notification fiber, so let it drain before marking the task hydrated.
        yield* Effect.sleep("100 millis");
        yield* update(id, (current) => markHydrated(current, now()));
        return (yield* Ref.get(tasksRef)).get(id);
      });

    const cancel = (id: string) => client.notify("session/cancel", { sessionId: id });

    const close = (id: string) =>
      Effect.gen(function* () {
        yield* client.request("session/close", { sessionId: id });
        yield* update(id, (task) => markClosed(task, now()));
      });

    const respondPermission = (
      id: string,
      requestId: string,
      decision: { readonly optionId: string } | "cancel",
    ) =>
      Effect.gen(function* () {
        const entry = (yield* Ref.get(pendingRef)).get(requestId);
        if (entry === undefined || entry.taskId !== id) {
          return yield* new AcpError({ message: "Unknown permission request" });
        }
        yield* Ref.update(pendingRef, (pending) => {
          const next = new Map(pending);
          next.delete(requestId);
          return next;
        });
        yield* entry.incoming.reply(
          decision === "cancel" ? permissionCancelled() : permissionSelected(decision.optionId),
        );
        yield* update(id, (task) => resolvePermission(task, now()));
      });

    return {
      list: Effect.map(Ref.get(tasksRef), summarize),
      changes: Stream.fromPubSub(changesPub),
      get: (id) => Effect.map(Ref.get(tasksRef), (tasks) => tasks.get(id)),
      create,
      hydrate,
      prompt,
      promptAndWait,
      cancel,
      close,
      respondPermission,
    };
  });

export const taskRegistryLayer: Layer.Layer<TaskRegistry, never, AcpClient> = Layer.effect(
  TaskRegistry,
  makeTaskRegistry,
);
