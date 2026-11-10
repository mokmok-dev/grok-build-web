import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Page } from "@playwright/test";

// NixOS cannot run Playwright's generic Linux download; the flake provides a patched headless shell.
const chromiumExecutable = (): string | undefined => {
  const override = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];
  if (override !== undefined) return override;
  try {
    const entry = readdirSync("/nix/store").find((name) =>
      name.endsWith("-playwright-chromium-headless-shell"),
    );
    if (entry === undefined) return undefined;
    return `/nix/store/${entry}/chrome-headless-shell-linux64/chrome-headless-shell`;
  } catch {
    return undefined;
  }
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });

const reachable = async (port: number): Promise<boolean> => {
  const response = await fetch(`http://127.0.0.1:${port}/`).catch(() => undefined);
  return response !== undefined;
};

const waitForHttp = async (url: string, timeoutMs: number): Promise<void> => {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    if (Date.now() - started > timeoutMs) throw new Error(`${url} did not become ready`);
    await delay(100);
  }
};

const children: ChildProcess[] = [];

const start = (
  command: string,
  args: string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): ChildProcess => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[${command}] ${chunk}`));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[${command}] ${chunk}`));
  children.push(child);
  return child;
};

const stopAll = async (): Promise<void> => {
  const pending = children.splice(0);
  for (const child of pending) {
    if (child.pid === undefined) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  await Promise.all(
    pending.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
          setTimeout(resolve, 5_000);
        }),
    ),
  );
};

const errors: string[] = [];

const watch = (page: Page): void => {
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
};

const run = async (): Promise<void> => {
  const agentPort = await freePort();
  const apiPort = await freePort();
  const webPort = await freePort();
  const agentUrl = `ws://127.0.0.1:${agentPort}/ws`;
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;

  console.log(`ports: agent=${agentPort} api=${apiPort} web=${webPort}`);
  start("grok", ["agent", "--always-approve", "serve", "--bind", `127.0.0.1:${agentPort}`, "--secret", "testsecret"]);
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await reachable(agentPort)) break;
    await delay(200);
  }

  const serverEntry = resolve(repoRoot, "apps/server/dist/main.js");
  if (!existsSync(serverEntry)) {
    throw new Error(`${serverEntry} is missing; run pnpm build first`);
  }
  start("node", [serverEntry], {
    env: {
      GROK_ACP_URL: agentUrl,
      GROK_ACP_SECRET: "testsecret",
      PORT: String(apiPort),
      GROK_WEB_DEFAULT_CWD: "/tmp",
    },
  });
  await waitForHttp(`${apiUrl}/api/health`, 30_000);

  start(resolve(repoRoot, "apps/web/node_modules/.bin/vite"), [
    "--port",
    String(webPort),
    "--strictPort",
  ], {
    cwd: resolve(repoRoot, "apps/web"),
    env: { GROK_WEB_API_URL: apiUrl },
  });
  await waitForHttp(webUrl, 60_000);

  const browser = await chromium.launch({ executablePath: chromiumExecutable() });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    watch(page);

    await page.goto(webUrl, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".connection-connected")).toHaveText("Connected", {
      timeout: 30_000,
    });
    console.log("connection status: Connected");

    await page.getByRole("button", { name: "New task" }).click();
    await page.getByLabel("Working directory").fill("/tmp");
    await page.getByLabel("First prompt").fill("Reply with the single word: pong");
    await page.getByRole("button", { name: "Create task" }).click();

    await expect(page.getByText(/^pong$/i).first()).toBeVisible({ timeout: 120_000 });
    console.log("streamed assistant text: pong");

    const badge = page.locator(".task-header [data-testid=status-badge]");
    await expect(badge).toContainText("Idle", { timeout: 60_000 });
    console.log("final status: Idle");

    const taskUrl = page.url();
    await page.screenshot({ path: "/tmp/grok-web-e2e-desktop.png", fullPage: true });
    console.log("screenshot: /tmp/grok-web-e2e-desktop.png");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open task list" }).click();
    const drawer = page.locator(".sidebar.open");
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Open task list" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await page.screenshot({ path: "/tmp/grok-web-e2e-mobile.png", fullPage: false });
    console.log("screenshot: /tmp/grok-web-e2e-mobile.png");

    // Clean up the session created by this run.
    const tasks = (await (await fetch(`${apiUrl}/api/tasks`)).json()) as {
      tasks: Array<{ id: string; status: string }>;
    };
    for (const task of tasks.tasks) {
      if (task.status !== "closed") {
        await fetch(`${apiUrl}/api/tasks/${task.id}/close`, { method: "POST" });
      }
    }
    console.log(`closed ${tasks.tasks.length} session(s) at ${taskUrl}`);

    await context.close();
  } finally {
    await browser.close();
  }

  if (errors.length > 0) {
    throw new Error(`browser errors: ${errors.join("; ")}`);
  }
  console.log("no page errors");
};

run()
  .then(async () => {
    await stopAll();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await stopAll();
    process.exit(1);
  });
