import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { HttpServerRequest } from "effect/http";
import { describe, expect, it } from "vitest";
import { AcpError } from "@grok-build-web/acp-client";
import { createTask, toDetail, type Task } from "@grok-build-web/task-model";
import {
  loadConfig,
  parseAcpUrl,
  redactUrl,
  resolveDefaultCwd,
  resolveRoots,
} from "../src/config.ts";
import { fsBridgeLayer, FsBridge, type FsBridgeShape } from "../src/fs-bridge.ts";
import { resolveTerminalCwd, taskCwdAllowed } from "../src/paths.ts";
import { realpathOfExistingAncestor } from "../src/realpath.ts";
import { checkRequest, readJsonBody, requestGuardPolicy } from "../src/security.ts";
import { makeTerminalRegistry } from "../src/terminal.ts";

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), "grok-web-unit-"));
const options = { allowedRoots: [], readOnly: false, maxFileBytes: 1024 };

const runFs = async <A>(
  settings: { allowedRoots: readonly string[]; readOnly: boolean; maxFileBytes?: number },
  use: (fs: FsBridgeShape) => Effect.Effect<A, AcpError>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FsBridge;
      return yield* use(fs);
    }).pipe(Effect.provide(fsBridgeLayer({ maxFileBytes: 1024, ...settings }))),
  );

const failure = async (effect: Effect.Effect<unknown, AcpError>): Promise<string> => {
  const exit = await Effect.runPromise(Effect.exit(effect));
  if (exit._tag === "Success") throw new Error("expected a failure");
  return String(exit.cause);
};

const webRequest = (body: string, headers: Record<string, string>): Request =>
  new Request("http://127.0.0.1/api", { method: "POST", headers, body });

describe("loadConfig", () => {
  it("applies defaults and resolves roots", () => {
    const config = loadConfig({});
    expect(config.acpUrl).toBe("ws://127.0.0.1:2419/ws");
    expect(config.acpSecret).toBeUndefined();
    expect(config.port).toBe(3000);
    expect(config.host).toBe("127.0.0.1");
    expect(config.allowedRoots).toEqual([]);
    expect(config.readOnly).toBe(false);
    expect(config.maxTerminals).toBe(8);
    expect(config.terminalOutputLimit).toBe(1_048_576);
    expect(config.maxTasks).toBe(100);
    expect(config.maxFileBytes).toBe(2_097_152);
    expect(config.maxBodyBytes).toBe(262_144);
    expect(config.promptTimeoutMs).toBe(1_800_000);
    expect(config.permissionTimeoutMs).toBe(300_000);
    expect(config.eventsHeartbeatMs).toBe(15_000);
    expect(config.allowedOrigins).toEqual([]);
    expect(config.allowedHosts).toEqual([]);
    expect(config.defaultCwd).toBe(process.cwd());
    expect(config.defaultModel).toBeUndefined();
  });

  it("reads overrides, splits lists and drops the filesystem root", () => {
    const config = loadConfig({
      GROK_ACP_URL: "ws://example/ws",
      GROK_AGENT_SECRET: "legacy",
      PORT: "4000",
      HOST: "0.0.0.0",
      GROK_WEB_ALLOWED_ROOTS: ":/a: /b :",
      GROK_WEB_READ_ONLY: "1",
      GROK_WEB_MAX_TERMINALS: "2",
      GROK_WEB_MAX_TASKS: "3",
      GROK_WEB_TERMINAL_OUTPUT_LIMIT: "10",
      GROK_WEB_DEFAULT_CWD: "/work",
      GROK_WEB_DEFAULT_MODEL: "m",
      GROK_WEB_ALLOWED_ORIGINS: "https://one, https://two",
      GROK_WEB_ALLOWED_HOSTS: "lan.example",
    });
    expect(config).toMatchObject({
      acpUrl: "ws://example/ws",
      acpSecret: "legacy",
      port: 4000,
      host: "0.0.0.0",
      allowedRoots: ["/a", "/b"],
      readOnly: true,
      maxTerminals: 2,
      maxTasks: 3,
      terminalOutputLimit: 10,
      defaultCwd: "/work",
      defaultModel: "m",
      allowedOrigins: ["https://one", "https://two"],
      allowedHosts: ["lan.example"],
    });
  });

  it("prefers GROK_ACP_SECRET and ignores empty values", () => {
    expect(loadConfig({ GROK_ACP_SECRET: "a", GROK_AGENT_SECRET: "b" }).acpSecret).toBe("a");
    expect(loadConfig({ GROK_ACP_SECRET: "" }).acpSecret).toBeUndefined();
  });

  it("falls back for an invalid port", () => {
    expect(loadConfig({ PORT: "nope" }).port).toBe(3000);
  });

  it("resolves relative roots against the server cwd", () => {
    expect(resolveRoots("rel:/tmp", "/work")).toEqual(["/work/rel", "/tmp"]);
    expect(resolveRoots("/", "/work")).toEqual([]);
    expect(resolveDefaultCwd("/", "/work")).toBe("/work");
    expect(resolveDefaultCwd("sub", "/work")).toBe("/work/sub");
  });
});

describe("parseAcpUrl", () => {
  it("accepts ws and wss only", () => {
    expect(parseAcpUrl("ws://host/ws")).toBe("ws://host/ws");
    expect(parseAcpUrl("wss://host/ws")).toBe("wss://host/ws");
    expect(parseAcpUrl("http://host/ws")).toBeUndefined();
    expect(parseAcpUrl("not a url")).toBeUndefined();
  });
});

describe("redactUrl", () => {
  it("masks credentials and sensitive query parameters", () => {
    const redacted = redactUrl("ws://user:pass@host/ws?server-key=a&token=b&room=1&Password=c");
    expect(redacted).toBe("ws://host/ws?server-key=***&token=***&room=1&Password=***");
  });

  it("leaves a clean url alone", () => {
    expect(redactUrl("ws://host/ws")).toBe("ws://host/ws");
  });

  it("is total", () => {
    expect(redactUrl("not a url")).toBe("invalid URL");
  });
});

describe("request guard", () => {
  const policy = requestGuardPolicy({
    host: "127.0.0.1",
    allowedHosts: [],
    allowedOrigins: [],
  });

  it("accepts loopback hosts with and without a port", () => {
    expect(checkRequest({ host: "127.0.0.1:3000" }, policy)).toBeUndefined();
    expect(checkRequest({ host: "localhost:3000" }, policy)).toBeUndefined();
    expect(checkRequest({ host: "[::1]:3000" }, policy)).toBeUndefined();
  });

  it("rejects foreign and missing hosts", () => {
    expect(checkRequest({ host: "evil.example" }, policy)).toMatchObject({ status: 403 });
    expect(checkRequest({}, policy)).toMatchObject({ status: 403 });
    expect(checkRequest({ host: "not a host" }, policy)).toMatchObject({ status: 403 });
  });

  it("accepts a missing origin and the same origin", () => {
    expect(checkRequest({ host: "127.0.0.1:3000" }, policy)).toBeUndefined();
    expect(
      checkRequest({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }, policy),
    ).toBeUndefined();
  });

  it("accepts the vite dev origins only", () => {
    expect(
      checkRequest({ host: "127.0.0.1:3000", origin: "http://localhost:5173" }, policy),
    ).toBeUndefined();
    expect(
      checkRequest({ host: "127.0.0.1:3000", origin: "http://localhost:4173" }, policy),
    ).toBeUndefined();
    expect(
      checkRequest({ host: "127.0.0.1:3000", origin: "http://localhost:9999" }, policy),
    ).toMatchObject({ status: 403 });
  });

  it("rejects foreign, opaque and malformed origins", () => {
    expect(
      checkRequest({ host: "127.0.0.1:3000", origin: "http://evil.example" }, policy),
    ).toMatchObject({ status: 403 });
    expect(checkRequest({ host: "127.0.0.1:3000", origin: "null" }, policy)).toMatchObject({
      status: 403,
    });
    expect(
      checkRequest({ host: "127.0.0.1:3000", origin: "ftp://127.0.0.1:5173" }, policy),
    ).toMatchObject({ status: 403 });
    expect(checkRequest({ host: "127.0.0.1:3000", origin: "not a url" }, policy)).toMatchObject({
      status: 403,
    });
  });

  it("honours configured origins and hosts", () => {
    const configured = requestGuardPolicy({
      host: "0.0.0.0",
      allowedHosts: ["lan.example"],
      allowedOrigins: ["https://console.example"],
    });
    expect(checkRequest({ host: "lan.example:3000" }, configured)).toBeUndefined();
    expect(
      checkRequest({ host: "127.0.0.1:3000", origin: "https://console.example" }, configured),
    ).toBeUndefined();
    expect(configured.hosts).not.toContain("0.0.0.0");
  });

  it("accepts a bracketed ipv6 host and rejects a malformed one", () => {
    expect(checkRequest({ host: "[::1]:3000" }, policy)).toBeUndefined();
    expect(checkRequest({ host: "LOCALHOST:3000" }, policy)).toBeUndefined();
    expect(checkRequest({ host: "bad host!!" }, policy)).toMatchObject({ status: 403 });
  });
});

describe("readJsonBody", () => {
  const read = (request: Request, limit = 1024) =>
    Effect.runPromise(readJsonBody(HttpServerRequest.fromWeb(request), limit));

  it("parses a JSON object", async () => {
    const result = await read(webRequest('{"a":1}', { "content-type": "application/json" }));
    expect(result).toEqual({ ok: true, value: { a: 1 } });
    const charset = await read(
      webRequest('{"a":1}', { "content-type": "application/json; charset=utf-8" }),
    );
    expect(charset).toEqual({ ok: true, value: { a: 1 } });
  });

  it("rejects lookalike media types", async () => {
    for (const mediaType of ["application/jsonp", "application/json-seq", "text/json"]) {
      const result = await read(webRequest("{}", { "content-type": mediaType }));
      expect(result).toMatchObject({ ok: false, status: 415 });
    }
  });

  it("requires a JSON content type", async () => {
    const result = await read(webRequest("a=1", { "content-type": "text/plain" }));
    expect(result).toMatchObject({ ok: false, status: 415 });
  });

  it("rejects invalid JSON", async () => {
    const result = await read(webRequest("{", { "content-type": "application/json" }));
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects bodies above the limit", async () => {
    const result = await read(
      webRequest('{"a":"0123456789"}', { "content-type": "application/json" }),
      4,
    );
    expect(result).toMatchObject({ ok: false, status: 413 });
    const declared = await read(
      webRequest('{"a":1}', {
        "content-type": "application/json",
        "content-length": "999",
      }),
      4,
    );
    expect(declared).toMatchObject({ ok: false, status: 413 });
  });
});

describe("paths", () => {
  it("allows the default cwd, its children and allowed roots", async () => {
    const root = await dir();
    const extra = await dir();
    const policy = { serverCwd: root, defaultCwd: root, allowedRoots: [extra] };
    expect(await Effect.runPromise(taskCwdAllowed(root, policy))).toBe(true);
    expect(await Effect.runPromise(taskCwdAllowed("sub", policy))).toBe(true);
    expect(await Effect.runPromise(taskCwdAllowed(extra, policy))).toBe(true);
  });

  it("rejects the filesystem root and unrelated paths", async () => {
    const root = await dir();
    const outside = await dir();
    const policy = { serverCwd: root, defaultCwd: root, allowedRoots: [] };
    expect(await Effect.runPromise(taskCwdAllowed("/", policy))).toBe(false);
    expect(await Effect.runPromise(taskCwdAllowed(outside, policy))).toBe(false);
    expect(await Effect.runPromise(taskCwdAllowed("../../etc", policy))).toBe(false);
  });

  it("rejects a symlink that leaves the default cwd", async () => {
    const root = await dir();
    const outside = await dir();
    const link = join(root, "escape");
    await symlink(outside, link);
    const policy = { serverCwd: root, defaultCwd: root, allowedRoots: [] };
    expect(await Effect.runPromise(taskCwdAllowed(link, policy))).toBe(false);
  });

  it("guards and resolves terminal cwds", async () => {
    const root = await dir();
    const extra = await dir();
    expect(await Effect.runPromise(resolveTerminalCwd("sub", root, [extra]))).toBe(
      await realpathOfExistingAncestor(join(root, "sub")),
    );
    expect(await Effect.runPromise(resolveTerminalCwd(extra, root, [extra]))).toBe(
      await realpathOfExistingAncestor(extra),
    );
    expect(await Effect.runPromise(resolveTerminalCwd("/", root, [extra]))).toBeUndefined();
    expect(await Effect.runPromise(resolveTerminalCwd("/etc", root, [extra]))).toBeUndefined();
  });
});

describe("FsBridge", () => {
  it("reads inside the working directory", async () => {
    const root = await dir();
    await writeFile(join(root, "a.txt"), "hi");
    expect(await runFs(options, (fs) => fs.read(root, "a.txt"))).toBe("hi");
  });

  it("reads inside an allowed root", async () => {
    const root = await dir();
    const extra = await dir();
    await writeFile(join(extra, "b.txt"), "ok");
    expect(
      await runFs({ ...options, allowedRoots: [extra] }, (fs) =>
        fs.read(root, join(extra, "b.txt")),
      ),
    ).toBe("ok");
  });

  it("accepts a symlinked working directory", async () => {
    const real = await dir();
    const linkParent = await dir();
    const link = join(linkParent, "link");
    await symlink(real, link);
    await writeFile(join(real, "a.txt"), "via-link");
    expect(await runFs(options, (fs) => fs.read(link, "a.txt"))).toBe("via-link");
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
        }).pipe(Effect.provide(fsBridgeLayer(options))),
      ),
    ).toContain("outside the allowed roots");
    expect(
      await failure(
        Effect.gen(function* () {
          const fs = yield* FsBridge;
          return yield* fs.read(root, "../etc/passwd");
        }).pipe(Effect.provide(fsBridgeLayer(options))),
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
        }).pipe(Effect.provide(fsBridgeLayer(options))),
      ),
    ).toContain("outside the allowed roots");
  });

  it("writes files unless read-only", async () => {
    const root = await dir();
    await runFs(options, (fs) => fs.write(root, "new.txt", "data"));
    expect(await runFs(options, (fs) => fs.read(root, "new.txt"))).toBe("data");
    expect(
      await failure(
        Effect.gen(function* () {
          const fs = yield* FsBridge;
          return yield* fs.write(root, "blocked.txt", "data");
        }).pipe(Effect.provide(fsBridgeLayer({ ...options, readOnly: true }))),
      ),
    ).toContain("Read-only mode");
  });

  it("reports unreadable files and size limits", async () => {
    const root = await dir();
    expect(
      await failure(
        Effect.gen(function* () {
          const fs = yield* FsBridge;
          return yield* fs.read(root, "missing.txt");
        }).pipe(Effect.provide(fsBridgeLayer(options))),
      ),
    ).toContain("Cannot read");
    await writeFile(join(root, "big.txt"), "x".repeat(64));
    expect(
      await failure(
        Effect.gen(function* () {
          const fs = yield* FsBridge;
          return yield* fs.read(root, "big.txt");
        }).pipe(Effect.provide(fsBridgeLayer({ ...options, maxFileBytes: 8 }))),
      ),
    ).toContain("larger than 8 bytes");
  });
});

describe("TerminalRegistry", () => {
  const options = { readOnly: false, maxTerminals: 2, outputByteLimit: 1024 };

  it("keys terminals by session", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeTerminalRegistry(options);
        const id = yield* registry.create("session-a", {
          command: "node",
          args: ["-e", "process.stdout.write('hi')"],
          env: [],
        });
        const own = yield* registry.get("session-a", id);
        const foreign = yield* registry.get("session-b", id);
        if (own === undefined) throw new Error("missing terminal");
        yield* Effect.promise(() => own.waitForExit());
        const output = own.read();
        yield* registry.release("session-b", id);
        const stillThere = yield* registry.get("session-a", id);
        yield* registry.release("session-a", id);
        return { id, output, foreign, stillThere, after: yield* registry.get("session-a", id) };
      }).pipe(Effect.scoped),
    );
    expect(result.id).toMatch(/^terminal-\d+$/);
    expect(result.output.output).toBe("hi");
    expect(result.foreign).toBeUndefined();
    expect(result.stillThere).toBeDefined();
    expect(result.after).toBeUndefined();
  });

  it("enforces read-only mode and the cap", async () => {
    const readOnly = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeTerminalRegistry({ ...options, readOnly: true });
        return yield* Effect.exit(registry.create("s", { command: "true", args: [], env: [] }));
      }).pipe(Effect.scoped),
    );
    expect(readOnly._tag).toBe("Failure");

    const capped = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeTerminalRegistry({ ...options, maxTerminals: 1 });
        yield* registry.create("s", {
          command: "node",
          args: ["-e", "setTimeout(() => {}, 5000)"],
          env: [],
        });
        return yield* Effect.exit(
          registry.create("s", {
            command: "node",
            args: ["-e", "setTimeout(() => {}, 5000)"],
            env: [],
          }),
        );
      }).pipe(Effect.scoped),
    );
    expect(capped._tag).toBe("Failure");
  });

  it("rejects invalid environment variables", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeTerminalRegistry(options);
        return yield* Effect.exit(
          registry.create("s", {
            command: "true",
            args: [],
            env: [{ name: "BAD-NAME", value: "1" }],
          }),
        );
      }).pipe(Effect.scoped),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("kills and shuts down terminals", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeTerminalRegistry(options);
        const id = yield* registry.create("s", {
          command: "node",
          args: ["-e", "setTimeout(() => {}, 30000)"],
          env: [],
        });
        yield* registry.kill("s", id);
        const terminal = yield* registry.get("s", id);
        if (terminal === undefined) throw new Error("terminal disappeared");
        const exit = yield* Effect.promise(() => terminal.waitForExit());
        expect(exit.signal).toBe("SIGTERM");
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
      yolo: false,
    });
  });
});
