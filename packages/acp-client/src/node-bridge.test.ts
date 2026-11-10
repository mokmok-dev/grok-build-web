import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEnvironment, readTextFile, startTerminal, writeTextFile } from "./node-bridge.ts";

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), "grok-web-bridge-"));
const options = { maxBytes: 1024 };

describe("readTextFile", () => {
  it("reads a whole file", async () => {
    const root = await dir();
    await writeTextFile(join(root, "a.txt"), "one\ntwo\nthree", options);
    expect(await readTextFile(join(root, "a.txt"), undefined, undefined, options)).toBe(
      "one\ntwo\nthree",
    );
  });

  it("reads a line window", async () => {
    const root = await dir();
    await writeTextFile(join(root, "a.txt"), "one\ntwo\nthree", options);
    expect(await readTextFile(join(root, "a.txt"), 2, undefined, options)).toBe("two\nthree");
    expect(await readTextFile(join(root, "a.txt"), 2, 1, options)).toBe("two");
    expect(await readTextFile(join(root, "a.txt"), 0, 1, options)).toBe("one");
    expect(await readTextFile(join(root, "a.txt"), 9, 1, options)).toBe("");
    expect(await readTextFile(join(root, "a.txt"), 1, 0, options)).toBe("");
  });

  it("rejects files above the byte limit", async () => {
    const root = await dir();
    await writeTextFile(join(root, "big.txt"), "x".repeat(64), { maxBytes: 10_000 });
    await expect(
      readTextFile(join(root, "big.txt"), undefined, undefined, { maxBytes: 16 }),
    ).rejects.toThrow("larger than 16 bytes");
  });

  it("refuses to follow a symlink", async () => {
    const root = await dir();
    await writeTextFile(join(root, "real.txt"), "data", options);
    await symlink(join(root, "real.txt"), join(root, "link.txt"));
    await expect(
      readTextFile(join(root, "link.txt"), undefined, undefined, options),
    ).rejects.toThrow();
  });

  it("writes files and rejects oversized content", async () => {
    const root = await dir();
    await writeTextFile(join(root, "b.txt"), "hello", options);
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("hello");
    await expect(
      writeTextFile(join(root, "c.txt"), "x".repeat(32), { maxBytes: 8 }),
    ).rejects.toThrow("larger than 8 bytes");
  });
});

describe("buildEnvironment", () => {
  it("strips the ACP secrets and keeps the rest", () => {
    const env = buildEnvironment(
      { PATH: "/bin", HOME: "/home/dev", GROK_ACP_SECRET: "a", GROK_AGENT_SECRET: "b" },
      [{ name: "EXTRA", value: "1" }],
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/dev", EXTRA: "1" });
  });

  it("rejects malformed names and NUL values", () => {
    expect(() => buildEnvironment({}, [{ name: "BAD-NAME", value: "1" }])).toThrow(
      "Invalid environment variable name",
    );
    expect(() => buildEnvironment({}, [{ name: "OK", value: "a\0b" }])).toThrow(
      "Invalid environment variable value",
    );
  });
});

describe("startTerminal", () => {
  it("captures output and the exit status", async () => {
    const terminal = startTerminal({
      command: "node",
      args: ["-e", "process.stdout.write('out');process.stderr.write('err')"],
      env: [{ name: "EXTRA", value: "1" }],
      outputByteLimit: 1024,
    });
    const exit = await terminal.waitForExit();
    expect(exit.exitCode).toBe(0);
    expect(terminal.read().output).toContain("out");
    expect(terminal.read().output).toContain("err");
    expect(terminal.read().truncated).toBe(false);
    expect(terminal.read().error).toBeUndefined();
  });

  it("truncates long output", async () => {
    const terminal = startTerminal({
      command: "node",
      args: ["-e", "process.stdout.write('x'.repeat(100))"],
      env: [],
      outputByteLimit: 10,
    });
    await terminal.waitForExit();
    expect(terminal.read()).toMatchObject({ output: "x".repeat(10), truncated: true });
  });

  it("passes the working directory and environment", async () => {
    const root = await dir();
    const terminal = startTerminal({
      command: "node",
      args: ["-e", "process.stdout.write(`${process.cwd()}|${process.env.EXTRA}`)"],
      env: [{ name: "EXTRA", value: "set" }],
      cwd: root,
      outputByteLimit: 4096,
    });
    await terminal.waitForExit();
    expect(terminal.read().output).toBe(`${root}|set`);
  });

  it("rejects when the command cannot start", async () => {
    const terminal = startTerminal({
      command: "definitely-not-a-command-xyz",
      args: [],
      env: [],
      outputByteLimit: 64,
    });
    await expect(terminal.waitForExit()).rejects.toThrow("Failed to start");
    expect(terminal.read().error).toContain("ENOENT");
  });

  it("kills the whole process group", async () => {
    const terminal = startTerminal({
      command: "node",
      args: ["-e", "setTimeout(() => {}, 60000)"],
      env: [],
      outputByteLimit: 1024,
    });
    terminal.kill();
    const exit = await terminal.waitForExit();
    expect(exit.signal).toBe("SIGTERM");
    terminal.release();
  });
});
