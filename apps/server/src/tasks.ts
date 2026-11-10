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
  applyNotification,
  applySessionChange,
  createTask,
  failPrompt,
  finishPrompt,
  markClosed,
  markError,
  markReady,
  resolvePermission,
  setPendingPermission,
  startPrompt,
  toSummary,
  type Task,
  type TaskSummary,
} from "@grok-build-web/task-model";
import { Context, Effect, Layer, PubSub, Ref, Scope, Stream } from "effect";
import { randomUUID } from "node:crypto";

export interface CreateTaskInput {
  readonly cwd: string;
  readonly prompt?: string;
  readonly model?: string;
  readonly yolo: boolean;
}

export interface TaskRegistryOptions {
  readonly maxTasks: number;
  readonly promptTimeoutMs: number;
  readonly permissionTimeoutMs: number;
}

export interface TaskRegistryShape {
  readonly list: Effect.Effect<readonly TaskSummary[]>;
  readonly changes: Stream.Stream<readonly TaskSummary[]>;
  readonly get: (id: string) => Effect.Effect<Task | undefined>;
  readonly create: (input: CreateTaskInput) => Effect.Effect<Task, AcpError>;
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

const now = (): number => Date.now();

/** Only these fields change the task list; streaming chunks update the task but not the snapshot. */
const projection = (task: Task): string =>
  JSON.stringify({
    status: task.status,
    title: task.title,
    model: task.model,
    messageCount: task.messages.length,
    usage: task.usage,
    lastError: task.lastError,
    pendingPermission: task.pendingPermission,
    yolo: task.yolo,
  });

export const makeTaskRegistry = (
  options: TaskRegistryOptions,
): Effect.Effect<TaskRegistryShape, never, AcpClient | Scope.Scope> =>
  Effect.gen(function* () {
    const client = yield* AcpClient;
    const tasksRef = yield* Ref.make<ReadonlyMap<string, Task>>(new Map());
    const pendingRef = yield* Ref.make<ReadonlyMap<string, PendingPermissionEntry>>(new Map());
    const changesPub = yield* PubSub.sliding<readonly TaskSummary[]>(32);

    const summarize = (tasks: ReadonlyMap<string, Task>): readonly TaskSummary[] =>
      [...tasks.values()].sort((left, right) => right.updatedAt - left.updatedAt).map(toSummary);

    const publish = Effect.gen(function* () {
      yield* PubSub.publish(changesPub, summarize(yield* Ref.get(tasksRef)));
    });

    const put = (task: Task) =>
      Effect.gen(function* () {
        const previous = (yield* Ref.get(tasksRef)).get(task.id);
        yield* Ref.update(tasksRef, (tasks) => new Map(tasks).set(task.id, task));
        if (previous === undefined || projection(previous) !== projection(task)) {
          yield* publish;
        }
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
        const auto = autoSelectOption(request.options, task.yolo);
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
            yield* Effect.sleep(options.permissionTimeoutMs);
            const taken = yield* Ref.modify(pendingRef, (pending) => {
              const entry = pending.get(requestId);
              if (entry === undefined) return [undefined, pending];
              const next = new Map(pending);
              next.delete(requestId);
              return [entry, next];
            });
            if (taken === undefined) return;
            yield* incoming.reply(permissionCancelled());
            yield* update(task.id, (current) => resolvePermission(current, now()));
          }),
        );
      });

    yield* Effect.forkScoped(
      client.incomingRequests.pipe(
        Stream.runForEach((incoming) =>
          handlePermission(incoming).pipe(Effect.catchCause(() => Effect.void)),
        ),
      ),
      { startImmediately: true },
    );
    yield* Effect.forkScoped(
      client.notifications.pipe(
        Stream.runForEach((notification) =>
          handleNotification(notification).pipe(Effect.catchCause(() => Effect.void)),
        ),
      ),
      { startImmediately: true },
    );
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
      { startImmediately: true },
    );

    const beginPrompt = (id: string, text: string) =>
      Effect.gen(function* () {
        const task = (yield* Ref.get(tasksRef)).get(id);
        if (task === undefined) return yield* new AcpError({ message: "Unknown task" });
        if (task.status === "closed") {
          return yield* new AcpError({ message: "Cannot prompt a closed task" });
        }
        if (task.runningPromptId !== undefined) {
          return yield* new AcpError({ message: "A prompt is already running for this task" });
        }
        const claimId = randomUUID();
        yield* put(startPrompt(task, claimId, text, now()));
        return claimId;
      });

    const runTurn = <A>(
      id: string,
      claimId: string,
      effect: Effect.Effect<A, AcpError>,
    ): Effect.Effect<A, AcpError> =>
      effect.pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.gen(function* () {
              // A late failure from an older turn must not fail the turn that owns the claim now.
              yield* update(id, (task) => failPrompt(task, claimId, error.message, now()));
              return yield* Effect.fail(error);
            }),
          onSuccess: (value) =>
            update(id, (task) => finishPrompt(task, claimId, now())).pipe(Effect.as(value)),
        }),
        // An aborted stream interrupts the turn; release the claim so the task can be prompted again.
        Effect.onInterrupt(() => update(id, (task) => finishPrompt(task, claimId, now()))),
      );

    const sendPrompt = (id: string, claimId: string, text: string) =>
      runTurn(
        id,
        claimId,
        client.request(
          "session/prompt",
          { sessionId: id, prompt: [{ type: "text", text }] },
          options.promptTimeoutMs,
        ),
      );

    const prompt = (id: string, text: string) =>
      Effect.gen(function* () {
        const claimId = yield* beginPrompt(id, text);
        yield* Effect.forkDetach(sendPrompt(id, claimId, text).pipe(Effect.ignoreCause));
      });

    const promptAndWait = (id: string, text: string) =>
      Effect.gen(function* () {
        const claimId = yield* beginPrompt(id, text);
        return parsePromptResult(yield* sendPrompt(id, claimId, text));
      });

    const create = (input: CreateTaskInput) =>
      Effect.gen(function* () {
        if ((yield* Ref.get(tasksRef)).size >= options.maxTasks) {
          return yield* new AcpError({ message: `Task limit reached (${options.maxTasks})` });
        }
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
          createTask({
            id: session.sessionId,
            cwd: input.cwd,
            model,
            yolo: input.yolo,
            now: now(),
          }),
          now(),
        );
        yield* put(task);
        if (input.prompt !== undefined) {
          yield* prompt(session.sessionId, input.prompt);
          return (yield* Ref.get(tasksRef)).get(session.sessionId) ?? task;
        }
        return task;
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
        const taken = yield* Ref.modify(pendingRef, (pending) => {
          const entry = pending.get(requestId);
          if (entry === undefined || entry.taskId !== id) return [undefined, pending];
          const next = new Map(pending);
          next.delete(requestId);
          return [entry, next];
        });
        if (taken === undefined) {
          return yield* new AcpError({ message: "Unknown permission request" });
        }
        yield* taken.incoming.reply(
          decision === "cancel" ? permissionCancelled() : permissionSelected(decision.optionId),
        );
        yield* update(id, (task) => resolvePermission(task, now()));
      });

    return {
      list: Effect.map(Ref.get(tasksRef), summarize),
      changes: Stream.fromPubSub(changesPub),
      get: (id) => Effect.map(Ref.get(tasksRef), (tasks) => tasks.get(id)),
      create,
      prompt,
      promptAndWait,
      cancel,
      close,
      respondPermission,
    };
  });

export const taskRegistryLayer = (
  options: TaskRegistryOptions,
): Layer.Layer<TaskRegistry, never, AcpClient> =>
  Layer.effect(TaskRegistry, makeTaskRegistry(options));
