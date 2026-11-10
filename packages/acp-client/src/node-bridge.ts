import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import type { EnvVariable, TerminalExitStatus } from "@grok-build-web/acp-protocol";
import { truncateOutput } from "./policy.ts";

const SECRET_ENV = ["GROK_ACP_SECRET", "GROK_AGENT_SECRET"];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const READ_CHUNK = 64 * 1024;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const WRITE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_TRUNC |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

export interface TerminalOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly EnvVariable[];
  readonly cwd?: string;
  readonly outputByteLimit: number;
}

export interface TerminalOutput {
  readonly output: string;
  readonly truncated: boolean;
  readonly exitStatus?: TerminalExitStatus;
  readonly error?: string;
}

export interface TerminalHandle {
  readonly read: () => TerminalOutput;
  readonly waitForExit: () => Promise<TerminalExitStatus>;
  readonly kill: () => void;
  readonly release: () => void;
}

/**
 * The agent's shell tool needs the developer environment, so everything is inherited except the
 * ACP secrets, which must never reach a command the agent (or the browser) can inspect.
 */
export const buildEnvironment = (
  base: NodeJS.ProcessEnv,
  extra: readonly EnvVariable[],
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || SECRET_ENV.includes(name)) continue;
    env[name] = value;
  }
  for (const variable of extra) {
    if (!ENV_NAME.test(variable.name)) {
      throw new TypeError(`Invalid environment variable name: ${variable.name}`);
    }
    if (variable.value.includes("\0")) {
      throw new TypeError(`Invalid environment variable value for ${variable.name}`);
    }
    env[variable.name] = variable.value;
  }
  return env;
};

const assertRegularFile = async (handle: FileHandle, path: string): Promise<number> => {
  const info = await handle.stat();
  if (!info.isFile()) throw new Error(`${path} is not a regular file`);
  return info.size;
};

const readAll = async (handle: FileHandle, path: string, maxBytes: number): Promise<string> => {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(READ_CHUNK);
  let total = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new Error(`${path} is larger than ${maxBytes} bytes`);
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString("utf8");
};

export const readTextFile = async (
  path: string,
  line: number | undefined,
  limit: number | undefined,
  maxBytes: number,
): Promise<string> => {
  const handle = await open(path, READ_FLAGS);
  try {
    const size = await assertRegularFile(handle, path);
    if (size > maxBytes) throw new Error(`${path} is larger than ${maxBytes} bytes`);
    const content = await readAll(handle, path, maxBytes);
    if (line === undefined && limit === undefined) return content;
    const lines = content.split("\n");
    const start = Math.max(0, (line ?? 1) - 1);
    const end = limit === undefined ? lines.length : start + limit;
    return lines.slice(start, end).join("\n");
  } finally {
    await handle.close();
  }
};

export const writeTextFile = async (
  path: string,
  content: string,
  maxBytes: number,
): Promise<void> => {
  const size = Buffer.byteLength(content, "utf8");
  if (size > maxBytes) throw new Error(`Content is larger than ${maxBytes} bytes`);
  const handle = await open(path, WRITE_FLAGS, 0o644);
  try {
    await assertRegularFile(handle, path);
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
};

export const startTerminal = (options: TerminalOptions): TerminalHandle => {
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: buildEnvironment(process.env, options.env),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let buffer = "";
  let truncated = false;
  let spawnError: string | undefined;
  const append = (chunk: string): void => {
    const capped = truncateOutput(buffer + chunk, options.outputByteLimit);
    buffer = capped.output;
    if (capped.truncated) truncated = true;
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  let exitStatus: TerminalExitStatus | undefined;
  const exited = new Promise<TerminalExitStatus>((resolve, reject) => {
    child.on("error", (error) => {
      spawnError = error.message;
      reject(new Error(`Failed to start ${options.command}: ${error.message}`));
    });
    child.on("exit", (code, signal) => {
      exitStatus = { exitCode: code ?? undefined, signal: signal ?? undefined };
      resolve(exitStatus);
    });
  });
  // The handle may be abandoned without a waiter; the failure is reported through read() as well.
  exited.catch(() => undefined);

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group is already gone.
    }
  };

  return {
    read: () => ({ output: buffer, truncated, exitStatus, error: spawnError }),
    waitForExit: () => exited,
    kill: () => {
      signalGroup("SIGTERM");
    },
    release: () => {
      // Descendants can outlive the leader, so always signal the whole group.
      signalGroup("SIGKILL");
    },
  };
};
