import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = resolve(repoRoot, "apps/server/dist/main.js");

/** The server suite runs from source; `main.ts` needs a current compiled entry. */
const ensureBuild = (): void => {
  execFileSync(
    process.execPath,
    [resolve(repoRoot, "node_modules/typescript/bin/tsc"), "-b", resolve(repoRoot, "apps/server")],
    { stdio: "pipe" },
  );
};

const freePort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });

interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

const spawnServer = (port: number) => {
  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      PORT: String(port),
      GROK_ACP_URL: "ws://127.0.0.1:1/ws",
      GROK_WEB_DEFAULT_CWD: tmpdir(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<RunResult>((resolveExit, reject) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal, stdout, stderr }));
    child.once("error", reject);
  });
  return { child, exited };
};

const waitForHealth = async (port: number, timeoutMs = 20_000): Promise<void> => {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // retry
    }
    if (Date.now() - started > timeoutMs) throw new Error("server never became healthy");
    await new Promise((done) => setTimeout(done, 100));
  }
};

const stop = (child: ChildProcess): void => {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
};

describe("main", () => {
  it("exits 1 when the port is already in use", async () => {
    ensureBuild();
    const blocker = createNetServer();
    await new Promise<void>((ready) => blocker.listen(0, "127.0.0.1", () => ready()));
    const address = blocker.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const { child, exited } = spawnServer(address.port);
    try {
      const result = await exited;
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("server failed to start");
      expect(result.stderr).toContain("EADDRINUSE");
    } finally {
      stop(child);
      blocker.close();
    }
  }, 60_000);

  it("exits 0 on SIGTERM", async () => {
    ensureBuild();
    const port = await freePort();
    const { child, exited } = spawnServer(port);
    try {
      await waitForHealth(port);
      child.kill("SIGTERM");
      const result = await exited;
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("received SIGTERM, shutting down");
    } finally {
      stop(child);
    }
  }, 60_000);
});
