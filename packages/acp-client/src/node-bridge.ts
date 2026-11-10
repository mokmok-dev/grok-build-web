import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import type { EnvVariable, TerminalExitStatus } from "@grok-build-web/acp-protocol";
import { truncateOutput } from "./policy.ts";

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
}

export interface TerminalHandle {
  readonly read: () => TerminalOutput;
  readonly waitForExit: () => Promise<TerminalExitStatus>;
  readonly kill: () => void;
  readonly release: () => void;
}

export const readTextFile = async (
  path: string,
  line?: number,
  limit?: number,
): Promise<string> => {
  const content = await readFile(path, "utf8");
  if (line === undefined) return content;
  const lines = content.split("\n");
  const start = line - 1;
  const end = limit === undefined ? lines.length : start + limit;
  return lines.slice(start, end).join("\n");
};

export const writeTextFile = async (path: string, content: string): Promise<void> => {
  await writeFile(path, content, "utf8");
};

export const startTerminal = (options: TerminalOptions): TerminalHandle => {
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: { ...process.env, ...Object.fromEntries(options.env.map((env) => [env.name, env.value])) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  let truncated = false;
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
  const exited = new Promise<TerminalExitStatus>((resolve) => {
    child.on("exit", (code, signal) => {
      exitStatus = { exitCode: code ?? undefined, signal: signal ?? undefined };
      resolve(exitStatus);
    });
  });

  return {
    read: () => ({ output: buffer, truncated, exitStatus }),
    waitForExit: () => exited,
    kill: () => {
      child.kill("SIGTERM");
    },
    release: () => {
      if (exitStatus === undefined) child.kill("SIGKILL");
    },
  };
};
