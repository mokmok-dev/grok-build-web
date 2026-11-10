import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";

const summary = {
  id: "s1",
  title: "My task",
  cwd: "/tmp/work",
  model: "m1",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  messageCount: 1,
  usage: {},
};

const routes: Record<string, unknown> = {
  "/api/health": { ok: true, acp: { connected: true, url: "ws://127.0.0.1:2419/ws" } },
  "/api/settings": {
    url: "ws://127.0.0.1:2419/ws",
    hasSecret: true,
    defaultCwd: "/tmp/work",
    readOnly: false,
  },
  "/api/agent": {
    connected: true,
    models: { availableModels: [] },
    availableCommands: [],
    capabilities: {},
  },
  "/api/tasks": { tasks: [summary] },
  "/api/tasks/s1": {
    ...summary,
    messages: [{ id: "u", role: "user", createdAt: 1, parts: [{ type: "text", text: "hi" }] }],
    plan: [],
    availableCommands: [],
    configOptions: [],
    queue: [],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const stubFetch = (): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      const body = routes[path];
      return new Response(JSON.stringify(body ?? {}), {
        status: body === undefined ? 404 : 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
};

describe("App", () => {
  it("loads tasks and shows the connection state", async () => {
    stubFetch();
    render(<App />);
    expect(await screen.findByText("My task")).toBeTruthy();
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.getByText(/work · m1/)).toBeTruthy();
  });
});
