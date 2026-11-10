import { spawn, type ChildProcess } from "node:child_process"
import { readdirSync } from "node:fs"
import { connect } from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { chromium, type Page } from "@playwright/test"

const agentUrl = "ws://127.0.0.1:2419/ws"

// NixOS cannot run Playwright's generic Linux download; the flake provides a patched headless shell instead.
const chromiumExecutable = (): string | undefined => {
  const override = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
  if (override !== undefined) return override
  try {
    const entry = readdirSync("/nix/store").find((name) => name.endsWith("-playwright-chromium-headless-shell"))
    if (entry === undefined) return undefined
    return `/nix/store/${entry}/chrome-headless-shell-linux64/chrome-headless-shell`
  } catch {
    return undefined
  }
}
const apiPort = 3000
const webUrl = "http://127.0.0.1:5173"

const reachable = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })

const waitForPort = async (port: number, timeoutMs: number): Promise<void> => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await reachable(port)) return
    await delay(200)
  }
  throw new Error(`port ${port} did not open`)
}

const waitForHttp = async (url: string, timeoutMs: number): Promise<void> => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // retry
    }
    await delay(200)
  }
  throw new Error(`${url} did not become ready`)
}

const children: ChildProcess[] = []

const start = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ChildProcess => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[${command}] ${chunk.toString()}`))
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[${command}] ${chunk.toString()}`))
  children.push(child)
  return child
}

const stopAll = (): void => {
  for (const child of children.splice(0)) {
    child.kill("SIGTERM")
  }
}

const run = async (): Promise<void> => {
  if (!(await reachable(2419))) {
    console.log("starting grok agent serve")
    start("grok", ["agent", "--always-approve", "serve", "--bind", "127.0.0.1:2419", "--secret", "testsecret"])
    await waitForPort(2419, 30_000)
  }

  if (!(await reachable(apiPort))) {
    console.log("starting grok-build-web server")
    start("node", ["apps/server/dist/main.js"], {
      env: {
        GROK_ACP_URL: agentUrl,
        GROK_ACP_SECRET: "testsecret",
        PORT: String(apiPort),
        GROK_WEB_DEFAULT_CWD: "/tmp",
      },
    })
    await waitForHttp(`http://127.0.0.1:${apiPort}/api/health`, 30_000)
  }

  if (!(await reachable(5173))) {
    console.log("starting vite dev server")
    start("pnpm", ["--filter", "@grok-build-web/web", "exec", "vite", "--port", "5173", "--strictPort"], {
      cwd: process.cwd(),
    })
    await waitForHttp(webUrl, 60_000)
  }

  const browser = await chromium.launch({ executablePath: chromiumExecutable() })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page: Page = await context.newPage()
  const logs: string[] = []
  page.on("console", (message) => logs.push(`${message.type()}: ${message.text()}`))
  page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`))

  try {
    await page.goto(webUrl, { waitUntil: "domcontentloaded" })
    await page.getByText("Connected").waitFor({ timeout: 30_000 })
    console.log("connection status: Connected")

    await page.getByRole("button", { name: "New task" }).click()
    await page.getByLabel("Working directory").fill("/tmp")
    await page.getByLabel("First prompt").fill("Reply with the single word: pong")
    await page.getByRole("button", { name: "Create task" }).click()

    await page.getByText("pong", { exact: true }).waitFor({ timeout: 120_000 })
    console.log("streamed assistant text: pong")

    await page.locator(".task-header [data-testid=status-badge]").getByText("Idle").waitFor({ timeout: 60_000 })
    console.log("final status: Idle")

    await page.screenshot({ path: "/tmp/grok-web-e2e-desktop.png", fullPage: true })
    console.log("screenshot: /tmp/grok-web-e2e-desktop.png")

    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole("button", { name: "Open task list" }).click()
    const drawer = page.locator(".sidebar.open")
    await drawer.waitFor({ timeout: 10_000 })
    await page.waitForTimeout(400)
    const box = await drawer.boundingBox()
    if (box === null || Math.abs(box.x) > 1) throw new Error(`drawer did not slide into view: x=${box?.x}`)
    console.log("mobile drawer opened")
    await page.screenshot({ path: "/tmp/grok-web-e2e-mobile.png", fullPage: false })
    console.log("screenshot: /tmp/grok-web-e2e-mobile.png")

    await page.setViewportSize({ width: 1280, height: 900 })
    await page.getByRole("button", { name: "Send" }).waitFor({ state: "visible" })
    console.log("composer visible on desktop")
    console.log(`console messages: ${logs.length}`)
  } finally {
    await browser.close()
  }
}

run()
  .then(() => {
    stopAll()
    process.exit(0)
  })
  .catch((error: unknown) => {
    console.error(error)
    stopAll()
    process.exit(1)
  })
