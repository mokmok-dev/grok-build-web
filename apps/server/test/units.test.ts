import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createTask, type Task } from "@grok-build-web/task-model";
import { AcpError } from "@grok-build-web/acp-client";
import { loadConfig, redactUrl } from "../src/config.ts";
import { fsBridgeLayer, FsBridge, type FsBridgeShape } from "../src/fs-bridge.ts";
import { makeTerminalRegistry } from "../src/terminal.ts";
import { toDetail } from "../src/api.ts";

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), "grok-web-unit-"));

const runFs = async <A>(
  options: { allowedRoots: readonly string[]; readOnly: boolean },
  use: (fs: FsBridgeShape) => Effect.Effect<A, AcpError>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FsBridge;
      return yield* use(fs);
    }).pipe(Effect.provide(fsBridgeLayer(options))),
  );

const failure = async (effect: Effect.Effect<unknown, AcpError>): Promise<string> => {
  const exit = await Effect.runPromise(Effect.exit(effect));
  if (exit._tag === "Success") throw new Error("expected a failure");
  return String(exit.cause);
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({});
    expect(config.acpUrl).toBe("ws://127.0.0.1:2419/ws");
    expect(config.acpSecret).toBeUndefined();
    expect(config.port).toBe(3000);
    expect(config.host).toBe("127.0.0.1");
    expect(config.allowedRoots).toEqual([]);
    expect(config.readOnly).toBe(false);
    expect(config.maxTerminals).toBe(8);
    expect(config.terminalOutputLimit).toBe(1_048_576);
    expect(config.defaultCwd).toBe(process.cwd());
    expect(config.defaultModel).toBeUndefined();
  });

  it("reads overrides and the legacy secret name", () => {
    const config = loadConfig({
      GROK_ACP_URL: "ws://example/ws",
      GROK_AGENT_SECRET: "legacy",
      PORT: "4000",
      HOST: "0.0.0.0",
      GROK_WEB_ALLOWED_ROOTS: "/a: /b :",
      GROK_WEB_READ_ONLY: "1",
      GROK_WEB_MAX_TERMINALS: "2",
      GROK_WEB_TERMINAL_OUTPUT_LIMIT: "10",
      GROK_WEB_DEFAULT_CWD: "/work",
      GROK_WEB_DEFAULT_MODEL: "m",
    });
    expect(config).toMatchObject({
      acpUrl: "ws://example/ws",
      acpSecret: "legacy",
      port: 4000,
      host: "0.0.0.0",
      allowedRoots: ["/a", "/b"],
      readOnly: true,
      maxTerminals: 2,
      terminalOutputLimit: 10,
      defaultCwd: "/work",
      defaultModel: "m",
    });
  });

  it("prefers GROK_ACP_SECRET and ignores empty values", () => {
    expect(loadConfig({ GROK_ACP_SECRET: "a", GROK_AGENT_SECRET: "b" }).acpSecret).toBe("a");
    expect(loadConfig({ GROK_ACP_SECRET: "" }).acpSecret).toBeUndefined();
  });

  it("falls back for an invalid port", () => {
    expect(loadConfig({ PORT: "nope" }).port).toBe(3000);
  });
});

describe("redactUrl", () => {
  it("masks the server key", () => {
    expect(redactUrl("ws://host/ws?server-key=secret")).toBe("ws://host/ws?server-key=***");
  });

  it("leaves a url without a key alone", () => {
    expect(redactUrl("ws://host/ws")).toBe("ws://host/ws");
  });
});

describe("FsBridge", () => {
  it("reads inside the working directory", async () => {
    const root = await dir();
    await writeFile(join(root, "a.txt"), "hi");
    const content = await runFs({ allowedRoots: [], readOnly: false }, (fs) =>
      fs.read(root, "a.txt"),
    );
    expect(content).toBe("hi");
  });

  it("reads inside an allowed root", async () => {
    const root = await dir();
    const extra = await dir();
    await writeFile(join(extra, "b.txt"), "ok");
    const content = await runFs({ allowedRoots: [extra], readOnly: false }, (fs) =>
      fs.read(root, join(extra, "b.txt")),
    );
    expect(content).toBe("ok");
  });

  it("rejects escapes and unrelated paths", async () => {
    const root = await dir();
    const outside = await dir();
    await writeFile(join(outside, "secret.txt"), "no");
    expect(
      await failure(
        Effect.gen(function* () {
          const fs = yield* FsBridge;
          return yield* fs.read(root, join(outside, "secret.txt"));
        }).pipe(Effect.provide(fsBridgeLayer({ allowedRoots: [], readOnly: false }))),
      ),
    ).toContain("outside the allowed roots");
    expect(
      await failure(
        Effect.gen(function* () {
          const fs = yield* FsBridge;
          return yield* fs.read(root, "../etc/passwd");
        }).pipe(Effect.provide(fsBridgeLayer({ allowedRoots: [], readOnly: false }))),
      ),
    ).toContain("outside the allowed roots");
  });

  it("rejects symlinks that leave the root", async () => {
    const root = await dir();
    const outside = await dir();
    await writeFile(join(outside, "secret.txt"), "no");
    await symlink(outside, join(root, "link"));
    expect(
      await failure(
        Effect.gen(function* () {
          const fs = yield* FsBridge;
          return yield* fs.read(root, "link/secret.txt");
        }).pipe(Effect.provide(fsBridgeLayer({ allowedRoots: [], readOnly: false }))),
      ),
    ).toContain("outside the allowed roots");
  });

  it("writes files unless read-only", async () => {
    const root = await dir();
    await runFs({ allowedRoots: [], readOnly: false }, (fs) => fs.write(root, "new.txt", "data"));
    expect(
      await runFs({ allowedRoots: [], readOnly: false }, (fs) => fs.read(root, "new.txt")),
    ).toBe("data");
    expect(
      await failure(
        Effect.gen(function* () {
          const fs = yield* FsBridge;
          return yield* fs.write(root, "blocked.txt", "data");
        }).pipe(Effect.provide(fsBridgeLayer({ allowedRoots: [], readOnly: true }))),
      ),
    ).toContain("Read-only mode");
  });

  it("reports unreadable files", async () => {
    const root = await dir();
    expect(
      await failure(
        Effect.gen(function* () {
          const fs = yield* FsBridge;
          return yield* fs.read(root, "missing.txt");
        }).pipe(Effect.provide(fsBridgeLayer({ allowedRoots: [], readOnly: false }))),
      ),
    ).toContain("Cannot read");
  });
});

describe("TerminalRegistry", () => {
  const options = { readOnly: false, maxTerminals: 2, outputByteLimit: 1024 };

  it("creates, reads and releases terminals", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeTerminalRegistry(options);
        const id = yield* registry.create({
          command: "node",
          args: ["-e", "process.stdout.write('hi')"],
          env: [],
        });
        const terminal = yield* registry.get(id);
        if (terminal === undefined) throw new Error("missing terminal");
        yield* Effect.promise(() => terminal.waitForExit());
        const output = terminal.read();
        yield* registry.release(id);
        return { id, output, after: yield* registry.get(id) };
      }).pipe(Effect.scoped),
    );
    expect(result.id).toBe("terminal-1");
    expect(result.output.output).toBe("hi");
    expect(result.after).toBeUndefined();
  });

  it("enforces read-only mode and the cap", async () => {
    const readOnly = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeTerminalRegistry({ ...options, readOnly: true });
        return yield* Effect.exit(registry.create({ command: "true", args: [], env: [] }));
      }).pipe(Effect.scoped),
    );
    expect(readOnly._tag).toBe("Failure");

    const capped = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeTerminalRegistry({ ...options, maxTerminals: 1 });
        yield* registry.create({
          command: "node",
          args: ["-e", "setTimeout(() => {}, 5000)"],
          env: [],
        });
        return yield* Effect.exit(
          registry.create({ command: "node", args: ["-e", "setTimeout(() => {}, 5000)"], env: [] }),
        );
      }).pipe(Effect.scoped),
    );
    expect(capped._tag).toBe("Failure");
  });

  it("kills and shuts down terminals", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeTerminalRegistry(options);
        const id = yield* registry.create({
          command: "node",
          args: ["-e", "setTimeout(() => {}, 30000)"],
          env: [],
        });
        yield* registry.kill(id);
        const terminal = yield* registry.get(id);
        const exit = yield* Effect.promise(
          () =>
            terminal?.waitForExit() ??
            Promise.resolve({} as { signal?: string; exitCode?: number }),
        );
        expect(exit.signal ?? exit.exitCode).toBeDefined();
        yield* registry.shutdown;
      }).pipe(Effect.scoped),
    );
  });
});

describe("toDetail", () => {
  it("projects task state", () => {
    const task: Task = {
      ...createTask({ id: "s1", cwd: "/tmp", title: "T", now: 1 }),
      messages: [{ id: "m", role: "user", createdAt: 1, parts: [{ type: "text", text: "hi" }] }],
      plan: [{ content: "a", priority: "high", status: "pending" }],
      availableCommands: [1],
      configOptions: [2],
      queue: [{ id: "q", kind: "prompt", text: "x" }],
    };
    expect(toDetail(task)).toMatchObject({
      id: "s1",
      messageCount: 1,
      messages: task.messages,
      plan: task.plan,
      availableCommands: [1],
      configOptions: [2],
      queue: task.queue,
    });
  });
});
