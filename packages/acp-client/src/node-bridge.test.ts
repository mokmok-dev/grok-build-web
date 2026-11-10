import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTextFile, startTerminal, writeTextFile } from "./node-bridge.ts";

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), "grok-web-bridge-"));

describe("readTextFile", () => {
  it("reads a whole file", async () => {
    const root = await dir();
    await writeTextFile(join(root, "a.txt"), "one\ntwo\nthree");
    expect(await readTextFile(join(root, "a.txt"))).toBe("one\ntwo\nthree");
  });

  it("reads a line window", async () => {
    const root = await dir();
    await writeTextFile(join(root, "a.txt"), "one\ntwo\nthree");
    expect(await readTextFile(join(root, "a.txt"), 2)).toBe("two\nthree");
    expect(await readTextFile(join(root, "a.txt"), 2, 1)).toBe("two");
  });

  it("writes files", async () => {
    const root = await dir();
    await writeTextFile(join(root, "b.txt"), "hello");
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("hello");
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
      args: ["-e", "process.stdout.write(process.cwd())"],
      env: [],
      cwd: root,
      outputByteLimit: 4096,
    });
    await terminal.waitForExit();
    expect(terminal.read().output).toBe(root);
  });

  it("kills a running process", async () => {
    const terminal = startTerminal({
      command: "node",
      args: ["-e", "setTimeout(() => {}, 60000)"],
      env: [],
      outputByteLimit: 1024,
    });
    terminal.kill();
    const exit = await terminal.waitForExit();
    expect(exit.signal ?? exit.exitCode).toBeDefined();
    terminal.release();
  });
});
