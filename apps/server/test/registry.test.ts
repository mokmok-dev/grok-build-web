import type { IncomingRequest, AcpStatusInfo } from "@grok-build-web/acp-client";
import { AcpClient, AcpError, type AcpClientShape } from "@grok-build-web/acp-client";
import type { ServerNotification } from "@grok-build-web/acp-protocol";
import { Effect, Fiber, PubSub, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { loadConfig, makeSettings, type ServerConfig, type SettingsShape } from "../src/config.ts";
import {
  makeTaskRegistry,
  type TaskRegistryOptions,
  type TaskRegistryShape,
} from "../src/tasks.ts";

interface StubOptions {
  readonly request?: (method: string, params: unknown) => Effect.Effect<unknown, AcpError>;
  readonly notifications?: Stream.Stream<ServerNotification>;
  readonly incomingRequests?: Stream.Stream<IncomingRequest>;
  readonly statusChanges?: Stream.Stream<AcpStatusInfo>;
}

interface Recorded {
  readonly method: string;
  readonly params: unknown;
}

const stubClient = (options: StubOptions, calls: Recorded[] = []) => {
  const client: AcpClientShape = {
    status: Effect.succeed({ state: "connected", url: "ws://stub" }),
    statusChanges: options.statusChanges ?? Stream.empty,
    notifications: options.notifications ?? Stream.empty,
    incomingRequests: options.incomingRequests ?? Stream.empty,
    connect: Effect.void,
    disconnect: Effect.void,
    reconfigure: (url) => {
      calls.push({ method: "reconfigure", params: url });
      return Effect.void;
    },
    notify: (method, params) => {
      calls.push({ method, params });
      return Effect.void;
    },
    request: (method, params) => {
      calls.push({ method, params });
      return (
        options.request?.(method, params) ?? Effect.fail(new AcpError({ message: "unexpected" }))
      );
    },
  };
  return { client, calls };
};

const registryOptions: TaskRegistryOptions = {
  maxTasks: 2,
  promptTimeoutMs: 0,
  permissionTimeoutMs: 1_000,
};

const sessionNew = { sessionId: "s1", models: { currentModelId: "m1" }, configOptions: [] };

const withRegistry = async <A>(
  options: StubOptions,
  use: (registry: TaskRegistryShape, calls: Recorded[]) => Effect.Effect<A, AcpError>,
  registry: TaskRegistryOptions = registryOptions,
): Promise<A> => {
  const stub = stubClient(options);
  return Effect.runPromise(
    Effect.gen(function* () {
      const tasks = yield* makeTaskRegistry(registry);
      return yield* use(tasks, stub.calls);
    }).pipe(Effect.provideService(AcpClient, stub.client), Effect.scoped),
  );
};

describe("TaskRegistry", () => {
  it("rejects an invalid session/new response", async () => {
    const exit = await withRegistry({ request: () => Effect.succeed({}) }, (registry) =>
      registry.create({ cwd: "/tmp", yolo: false }).pipe(Effect.exit),
    );
    expect(exit._tag).toBe("Failure");
    expect(String(exit._tag === "Failure" ? exit.cause : "")).toContain(
      "Invalid session/new response",
    );
  });

  it("configures an explicit model before the first prompt", async () => {
    const task = await withRegistry(
      {
        request: (method) => Effect.succeed(method === "session/new" ? sessionNew : {}),
      },
      (registry, calls) =>
        Effect.map(registry.create({ cwd: "/tmp", model: "model-x", yolo: false }), (created) => ({
          created,
          calls,
        })),
    );
    expect(task.created.model).toBe("model-x");
    expect(task.calls).toContainEqual({
      method: "session/set_config_option",
      params: { sessionId: "s1", configId: "model", value: { value: "model-x" } },
    });
  });

  it("inherits the model from session/new", async () => {
    const task = await withRegistry({ request: () => Effect.succeed(sessionNew) }, (registry) =>
      registry.create({ cwd: "/tmp", yolo: false }),
    );
    expect(task.model).toBe("m1");
  });

  it("marks the task error when a prompt fails", async () => {
    const { client } = stubClient({});
    const failing: AcpClientShape = {
      ...client,
      request: (method) =>
        method === "session/new"
          ? Effect.succeed(sessionNew)
          : Effect.fail(new AcpError({ message: "prompt exploded" })),
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeTaskRegistry(registryOptions);
        yield* registry.create({ cwd: "/tmp", yolo: false });
        yield* registry.prompt("s1", "hello");
        return yield* waitForTaskEffect(registry, (task) => task.status === "error");
      }).pipe(Effect.provideService(AcpClient, failing), Effect.scoped),
    );
    expect(result.status).toBe("error");
  });

  it("rejects a second prompt while one is running", async () => {
    const { client } = stubClient({});
    const hanging: AcpClientShape = {
      ...client,
      request: (method) => (method === "session/new" ? Effect.succeed(sessionNew) : Effect.never),
    };
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeTaskRegistry(registryOptions);
        yield* registry.create({ cwd: "/tmp", yolo: false });
        yield* registry.prompt("s1", "first");
        const running = yield* waitForTaskEffect(registry, (task) => task.status === "running");
        const second = yield* registry.prompt("s1", "second").pipe(Effect.exit);
        return { running, second };
      }).pipe(Effect.provideService(AcpClient, hanging), Effect.scoped),
    );
    expect(outcome.running.status).toBe("running");
    expect(outcome.second._tag).toBe("Failure");
    expect(String(outcome.second._tag === "Failure" ? outcome.second.cause : "")).toContain(
      "already running",
    );
  });

  it("rejects prompts for closed or unknown tasks", async () => {
    const exit = await withRegistry({ request: () => Effect.succeed(sessionNew) }, (registry) =>
      Effect.gen(function* () {
        yield* registry.create({ cwd: "/tmp", yolo: false });
        yield* registry.close("s1");
        const closed = yield* registry.prompt("s1", "x").pipe(Effect.exit);
        const unknown = yield* registry.prompt("nope", "x").pipe(Effect.exit);
        return { closed, unknown };
      }),
    );
    expect(exit.closed._tag).toBe("Failure");
    expect(String(exit.closed._tag === "Failure" ? exit.closed.cause : "")).toContain("closed");
    expect(exit.unknown._tag).toBe("Failure");
    expect(String(exit.unknown._tag === "Failure" ? exit.unknown.cause : "")).toContain(
      "Unknown task",
    );
  });

  it("closes and cancels tasks through the client", async () => {
    const result = await withRegistry(
      { request: (method) => Effect.succeed(method === "session/new" ? sessionNew : {}) },
      (registry, calls) =>
        Effect.gen(function* () {
          yield* registry.create({ cwd: "/tmp", yolo: false });
          yield* registry.cancel("s1");
          yield* registry.close("s1");
          const task = yield* registry.get("s1");
          return { task, calls };
        }),
    );
    expect(result.task?.status).toBe("closed");
    expect(result.calls).toContainEqual({ method: "session/cancel", params: { sessionId: "s1" } });
  });

  it("enforces the task limit", async () => {
    let created = 0;
    const exit = await withRegistry(
      {
        request: () => Effect.succeed({ ...sessionNew, sessionId: `s${++created}` }),
      },
      (registry) =>
        Effect.gen(function* () {
          yield* registry.create({ cwd: "/tmp", yolo: false });
          yield* registry.create({ cwd: "/tmp", yolo: false });
          return yield* registry.create({ cwd: "/tmp", yolo: false }).pipe(Effect.exit);
        }),
      { ...registryOptions, maxTasks: 2 },
    );
    expect(exit._tag).toBe("Failure");
    expect(String(exit._tag === "Failure" ? exit.cause : "")).toContain("Task limit reached (2)");
  });

  it("marks running tasks error when the connection fails", async () => {
    const statuses = await Effect.runPromise(PubSub.unbounded<AcpStatusInfo>());
    const { client } = stubClient({ statusChanges: Stream.fromPubSub(statuses) });
    const hanging: AcpClientShape = {
      ...client,
      request: (method) => (method === "session/new" ? Effect.succeed(sessionNew) : Effect.never),
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeTaskRegistry(registryOptions);
        yield* registry.create({ cwd: "/tmp", yolo: false });
        yield* registry.prompt("s1", "first");
        yield* waitForTaskEffect(registry, (task) => task.status === "running");
        yield* PubSub.publish(statuses, { state: "error", url: "ws://stub", lastError: "lost" });
        return yield* waitForTaskEffect(registry, (task) => task.status === "error");
      }).pipe(Effect.provideService(AcpClient, hanging), Effect.scoped),
    );
    expect(result.status).toBe("error");
  });

  it("rejects unknown permission requests", async () => {
    const exit = await withRegistry({ request: () => Effect.succeed(sessionNew) }, (registry) =>
      Effect.gen(function* () {
        yield* registry.create({ cwd: "/tmp", yolo: false });
        return yield* registry
          .respondPermission("s1", "missing", { optionId: "allow_once" })
          .pipe(Effect.exit);
      }),
    );
    expect(exit._tag).toBe("Failure");
    expect(String(exit._tag === "Failure" ? exit.cause : "")).toContain(
      "Unknown permission request",
    );
  });

  it("applies session changes and ignores model updates", async () => {
    const notifications = await Effect.runPromise(PubSub.unbounded<ServerNotification>());
    const { client } = stubClient({
      request: () => Effect.succeed(sessionNew),
      notifications: Stream.fromPubSub(notifications),
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeTaskRegistry(registryOptions);
        yield* registry.create({ cwd: "/tmp", yolo: false });
        yield* PubSub.publish(notifications, {
          kind: "sessions_changed",
          upserted: [
            {
              sessionId: "s1",
              title: "Renamed",
              activity: "idle",
            },
          ],
          removed: [],
        });
        const renamed = yield* waitForTaskEffect(registry, (task) => task.title === "Renamed");
        const before = yield* registry.get("s1");
        yield* PubSub.publish(notifications, { kind: "models_update", availableModels: [] });
        yield* Effect.sleep(20);
        const after = yield* registry.get("s1");
        return { renamed, before, after };
      }).pipe(Effect.provideService(AcpClient, client), Effect.scoped),
    );
    expect(result.renamed.title).toBe("Renamed");
    expect(result.after).toBe(result.before);
  });

  it("publishes only meaningful list changes", async () => {
    const notifications = await Effect.runPromise(PubSub.unbounded<ServerNotification>());
    const { client } = stubClient({
      request: () => Effect.succeed(sessionNew),
      notifications: Stream.fromPubSub(notifications),
    });
    const frames = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeTaskRegistry(registryOptions);
        const collector = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(registry.changes, 3)),
          { startImmediately: true },
        );
        yield* registry.create({ cwd: "/tmp", yolo: false });
        // The first chunk opens a message, so the count moves once.
        yield* PubSub.publish(notifications, {
          kind: "session_update",
          sessionId: "s1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hi" },
          },
        });
        // A second chunk only appends; it is not a list change.
        yield* PubSub.publish(notifications, {
          kind: "session_update",
          sessionId: "s1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: " there" },
          },
        });
        yield* PubSub.publish(notifications, {
          kind: "queue_changed",
          sessionId: "s1",
          entries: [],
          runningPromptId: "p",
        });
        return yield* Fiber.join(collector);
      }).pipe(Effect.provideService(AcpClient, client), Effect.scoped),
    );
    const statuses = frames.map((batch) => batch[0]?.status);
    const counts = frames.map((batch) => batch[0]?.messageCount);
    expect(statuses).toEqual(["idle", "idle", "running"]);
    expect(counts).toEqual([0, 1, 1]);
  });
});

const waitForTaskEffect = (
  registry: TaskRegistryShape,
  predicate: (task: {
    status: string;
    runningPromptId?: string;
    lastError?: string;
    title?: string;
  }) => boolean,
) =>
  Effect.gen(function* () {
    const started = Date.now();
    for (;;) {
      const task = yield* registry.get("s1");
      if (task !== undefined && predicate(task)) return task;
      if (Date.now() - started > 2_000) {
        return yield* Effect.fail(new AcpError({ message: "timed out waiting for the task" }));
      }
      yield* Effect.sleep(10);
    }
  });

describe("Settings", () => {
  const config: ServerConfig = loadConfig({ GROK_WEB_DEFAULT_CWD: "/work" });

  const run = <A>(
    use: (settings: SettingsShape, calls: Recorded[]) => Effect.Effect<A, AcpError>,
  ): Promise<A> => {
    const stub = stubClient({});
    return Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* makeSettings(config);
        return yield* use(settings, stub.calls);
      }).pipe(Effect.provideService(AcpClient, stub.client)),
    );
  };

  it("starts from the configured values", async () => {
    const state = await run((settings) => settings.get);
    expect(state).toMatchObject({
      url: config.acpUrl,
      secret: undefined,
      defaultCwd: "/work",
      defaultModel: undefined,
      readOnly: false,
    });
  });

  it("reconfigures only when the connection changes", async () => {
    const result = await run((settings, calls) =>
      Effect.gen(function* () {
        const first = yield* settings.update({ defaultModel: "m" });
        const second = yield* settings.update({ url: "ws://new/ws", secret: "s" });
        const third = yield* settings.update({ secret: "" });
        return { first, second, third, calls };
      }),
    );
    expect(result.first.ok).toBe(true);
    expect(result.second.ok).toBe(true);
    expect(result.third.ok).toBe(true);
    expect(result.third.ok && result.third.state.secret).toBeUndefined();
    const reconfigures = result.calls.filter((call) => call.method === "reconfigure");
    expect(reconfigures.map((call) => call.params)).toEqual(["ws://new/ws", "ws://new/ws"]);
  });

  it("keeps the default cwd inside the allowed roots", async () => {
    const restricted = loadConfig({
      GROK_WEB_DEFAULT_CWD: "/work",
      GROK_WEB_ALLOWED_ROOTS: "/work",
    });
    const stub = stubClient({});
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* makeSettings(restricted);
        const outside = yield* settings.update({ defaultCwd: "/tmp" });
        const inside = yield* settings.update({ defaultCwd: "/work/sub" });
        return { outside, inside };
      }).pipe(Effect.provideService(AcpClient, stub.client)),
    );
    expect(result.outside).toMatchObject({ ok: false });
    expect(result.inside.ok).toBe(true);
  });

  it("rejects invalid urls and cwds without storing them", async () => {
    const result = await run((settings) =>
      Effect.gen(function* () {
        const url = yield* settings.update({ url: "http://nope" });
        const cwd = yield* settings.update({ defaultCwd: "/" });
        const state = yield* settings.get;
        return { url, cwd, state };
      }),
    );
    expect(result.url).toMatchObject({ ok: false });
    expect(result.cwd).toMatchObject({ ok: false });
    expect(result.state.defaultCwd).toBe("/work");
    expect(result.state.url).toBe(config.acpUrl);
  });
});
